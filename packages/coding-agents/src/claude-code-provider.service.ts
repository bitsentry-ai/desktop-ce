import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { createClaudeCodeSubscriptionEnv } from './claude-code-env'
import { codingAgentsLogger as log } from './logger'
import type { LocalAiExecutionResult, LocalAiStreamDelta } from './types'
import {
  buildWindowsCmdCommandLine,
  getWindowsCmdExecutable,
  isWindowsCmdShim,
} from './windows-cmd'
import { linkSubprocessAbort } from './subprocess-lifecycle'

export type ClaudeCodeAccessLevel = 'supervised' | 'auto-accept-edits' | 'full-access'

export const DEFAULT_CLAUDE_CODE_ACCESS_LEVEL: ClaudeCodeAccessLevel = 'supervised'

export interface ClaudeCodeDebugRecorder {
  recordEvent(stage: string, data: Record<string, unknown>): void
  recordAnomaly(stage: string, data: Record<string, unknown>): void
}

export interface ClaudeCodeExecutionOptions {
  prompt: string
  binaryPath: string
  abortController: AbortController
  cwd?: string
  model?: string
  accessLevel?: ClaudeCodeAccessLevel
  maxTurns?: number
  contextWindow?: string
  allowedTools?: string[]
  onDelta?: (delta: LocalAiStreamDelta) => void
  debug?: ClaudeCodeDebugRecorder
}

type ClaudeCodePermissionMode = 'acceptEdits' | 'bypassPermissions'
type ClaudeCodeSdkBeta = 'context-1m-2025-08-07'

interface ClaudeCodeSpawnOptions {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

type ClaudeCodeSpawnedProcess = ChildProcess

interface ClaudeCodeQueryOptions {
  abortController: AbortController
  cwd?: string
  model?: string
  maxTurns: number
  pathToClaudeCodeExecutable: string
  settingSources: Array<'user' | 'project' | 'local'>
  includePartialMessages: boolean
  env: NodeJS.ProcessEnv
  permissionMode?: ClaudeCodePermissionMode
  allowDangerouslySkipPermissions?: boolean
  betas?: ClaudeCodeSdkBeta[]
  allowedTools?: string[]
  tools?: []
  spawnClaudeCodeProcess?: (
    options: ClaudeCodeSpawnOptions,
  ) => ClaudeCodeSpawnedProcess
}

interface ClaudeCodeSessionState {
  output: string
  streamedOutput: boolean
  sessionId: string | undefined
  resumeCursor: unknown
  tokenUsage: LocalAiExecutionResult['tokenUsage']
}

interface ClaudeSdkSession extends AsyncIterable<unknown> {
  getContextUsage(): Promise<{
    totalTokens: number
    maxTokens: number
  }>
  close(): void
}

type ClaudeSdkQuery = (params: {
  prompt: string
  options?: ClaudeCodeQueryOptions
}) => ClaudeSdkSession

let testClaudeSdkQueryLoader: (() => Promise<ClaudeSdkQuery> | ClaudeSdkQuery) | undefined
const CLAUDE_ONE_M_CONTEXT_BETA: ClaudeCodeSdkBeta = 'context-1m-2025-08-07'

export function __setLoadClaudeSdkQueryForTests(
  loader: (() => Promise<ClaudeSdkQuery> | ClaudeSdkQuery) | undefined,
): void {
  testClaudeSdkQueryLoader = loader
}

async function loadClaudeSdkQuery(): Promise<ClaudeSdkQuery> {
  if (testClaudeSdkQueryLoader !== undefined) {
    return await testClaudeSdkQueryLoader()
  }

  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  return (params) => sdk.query({
    prompt: params.prompt,
    options: params.options as never,
  })
}

function attachSubprocessTermination(child: ChildProcess, signal: AbortSignal | undefined): void {
  const disposeAbort = linkSubprocessAbort(child, signal)
  child.once('close', disposeAbort)
}

function resolveClaudePermissionMode(
  accessLevel: ClaudeCodeAccessLevel,
): ClaudeCodeQueryOptions['permissionMode'] {
  if (accessLevel === 'auto-accept-edits') return 'acceptEdits'
  if (accessLevel === 'full-access') return 'bypassPermissions'
  return undefined
}

function createWindowsCmdShimSpawner(): (
  options: ClaudeCodeSpawnOptions,
) => ClaudeCodeSpawnedProcess {
  return (options: ClaudeCodeSpawnOptions): ClaudeCodeSpawnedProcess => {
    const env = options.env ?? process.env
    const child = spawn(
      getWindowsCmdExecutable(env),
      ['/d', '/s', '/c', buildWindowsCmdCommandLine(options.command, options.args)],
      {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
    attachSubprocessTermination(child, options.signal)

    return child
  }
}

function resolveAllowedTools(accessLevel: ClaudeCodeAccessLevel): string[] | undefined {
  switch (accessLevel) {
    case 'supervised':
      return []
    case 'auto-accept-edits':
      // Read + write tools, but no shell/command execution.
      return ['Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write']
    case 'full-access':
      return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  return undefined
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  return undefined
}

function extractClaudeTextBlock(
  value: unknown,
): { type?: string; text?: string } | undefined {
  return asRecord(value)
}

function splitClaudeStreamText(text: string): string[] {
  if (text.length <= 8) {
    return Array.from(text)
  }

  const wordLikeChunks = text.match(/\S+\s*|\s+/g)
  if (wordLikeChunks === null || wordLikeChunks.length === 0) {
    return [text]
  }

  return wordLikeChunks
}

function emitTextProgressively(
  text: string,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  for (const piece of splitClaudeStreamText(text)) {
    onDelta?.({ type: 'text', text: piece })
  }
}

function recordClaudeTextDelta(
  state: ClaudeCodeSessionState,
  text: string,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  state.streamedOutput = true
  state.output += text
  debug?.recordEvent('claude.delta_received', {
    provider: 'claude_code',
    accessLevel,
    sessionId: state.sessionId ?? null,
    deltaLength: text.length,
    accumulatedLength: state.output.length,
  })
  emitTextProgressively(text, onDelta)
}

function handleAssistantTextBlock(
  state: ClaudeCodeSessionState,
  text: string,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  if (state.streamedOutput) {
    return
  }

  state.output += text
  debug?.recordAnomaly('claude.assistant_block_without_stream_deltas', {
    provider: 'claude_code',
    accessLevel,
    sessionId: state.sessionId ?? null,
    deltaLength: text.length,
    accumulatedLength: state.output.length,
  })
  emitTextProgressively(text, onDelta)
}

function handleAssistantContentBlock(
  block: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  if (block.type === 'text' && typeof block.text === 'string') {
    handleAssistantTextBlock(state, block.text, accessLevel, debug, onDelta)
    return
  }
  if (block.type === 'tool_use') {
    onDelta?.({
      type: 'tool_start',
      toolName: asString(block.name) ?? 'tool',
    })
    return
  }
  if (block.type === 'tool_result') {
    onDelta?.({ type: 'tool_end' })
  }
}

function handleAssistantMessage(
  msg: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const innerMessage = asRecord(msg.message)
  const content = innerMessage?.content
  if (Array.isArray(content)) {
    for (const block of content) {
      const blockRecord = asRecord(block)
      if (blockRecord !== undefined) {
        handleAssistantContentBlock(blockRecord, state, accessLevel, debug, onDelta)
      }
    }
  }

  const uuid = asString(msg.uuid)
  if (uuid !== undefined) {
    state.resumeCursor = {
      sessionId: state.sessionId,
      lastMessageUuid: uuid,
    }
  }
}

function handleContentBlockStart(
  event: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const contentBlock = extractClaudeTextBlock(
    event.content_block ?? event.contentBlock,
  )
  if (
    contentBlock?.type === 'text' &&
    typeof contentBlock.text === 'string' &&
    contentBlock.text.length > 0
  ) {
    recordClaudeTextDelta(state, contentBlock.text, accessLevel, debug, onDelta)
  }
}

function handleContentBlockDelta(
  event: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const delta = asRecord(event.delta)
  if (delta === undefined) {
    return
  }
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    recordClaudeTextDelta(state, delta.text, accessLevel, debug, onDelta)
    return
  }
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    onDelta?.({ type: 'reasoning', text: delta.thinking })
  }
}

function handleStreamEventMessage(
  msg: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const event = asRecord(msg.event)
  if (event === undefined) {
    return
  }

  const eventType = asString(event.type)
  if (eventType === 'content_block_start') {
    handleContentBlockStart(event, state, accessLevel, debug, onDelta)
    return
  }
  if (eventType === 'content_block_delta') {
    handleContentBlockDelta(event, state, accessLevel, debug, onDelta)
  }
}

function applyTokenUsage(
  state: ClaudeCodeSessionState,
  usage: Record<string, unknown> | undefined,
): void {
  const inputTokens = asNumber(usage?.input_tokens)
  const outputTokens = asNumber(usage?.output_tokens)
  if (inputTokens === undefined && outputTokens === undefined) {
    return
  }

  state.tokenUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
}

function handleResultMessage(
  msg: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const subtype = asString(msg.subtype)
  if (subtype === 'success') {
    handleSuccessResultMessage(msg, state, onDelta)
    return
  }

  if (subtype !== undefined && subtype.startsWith('error')) {
    handleErrorResultMessage(subtype, msg, onDelta)
  }
}

function handleSuccessResultMessage(
  msg: Record<string, unknown>,
  state: ClaudeCodeSessionState,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const resultOutput = asString(msg.result)
  if (resultOutput !== undefined && resultOutput.length > 0 && state.output.length === 0) {
    state.output = resultOutput
  }
  applyTokenUsage(state, asRecord(msg.usage))
  onDelta?.({ type: 'status', status: 'completed' })
}

function handleErrorResultMessage(
  subtype: string,
  msg: Record<string, unknown>,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const errorMsg = asString(msg.error)
  log.warn('[claude-code-provider] Query error:', subtype, errorMsg)
  onDelta?.({ type: 'status', status: 'failed' })
  throw new Error(`Claude Code error (${subtype}): ${errorMsg ?? 'unknown error'}`)
}

function handleSystemMessage(
  msg: Record<string, unknown>,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  if (msg.subtype !== 'status') {
    return
  }

  const body = asRecord(msg.body)
  if (typeof body?.message === 'string') {
    onDelta?.({ type: 'command_output', text: body.message })
  }
}

function handleClaudeSessionMessage(
  message: unknown,
  state: ClaudeCodeSessionState,
  accessLevel: ClaudeCodeAccessLevel,
  debug: ClaudeCodeDebugRecorder | undefined,
  onDelta: ClaudeCodeExecutionOptions['onDelta'],
): void {
  const msg = asRecord(message)
  if (msg === undefined) {
    return
  }

  state.sessionId = state.sessionId ?? asString(msg.session_id)
  switch (msg.type) {
    case 'assistant':
      handleAssistantMessage(msg, state, accessLevel, debug, onDelta)
      break
    case 'stream_event':
      handleStreamEventMessage(msg, state, accessLevel, debug, onDelta)
      break
    case 'result':
      handleResultMessage(msg, state, onDelta)
      break
    case 'system':
      handleSystemMessage(msg, onDelta)
      break
    default:
      break
  }
}

function resolveClaudeMaxTurns(
  accessLevel: ClaudeCodeAccessLevel,
  requestedMaxTurns: number | undefined,
): number {
  if (accessLevel === 'supervised') {
    return 1
  }

  return requestedMaxTurns ?? 8
}

function buildClaudeCodeQueryOptions(
  options: ClaudeCodeExecutionOptions,
  effectiveAccessLevel: ClaudeCodeAccessLevel,
): ClaudeCodeQueryOptions {
  const resolvedTools = options.allowedTools ?? resolveAllowedTools(effectiveAccessLevel)
  const permissionMode = resolveClaudePermissionMode(effectiveAccessLevel)
  const shouldWrapWindowsCmdShim =
    process.platform === 'win32' && isWindowsCmdShim(options.binaryPath)
  const queryOptions: ClaudeCodeQueryOptions = {
    abortController: options.abortController,
    cwd: options.cwd,
    model: options.model,
    maxTurns: resolveClaudeMaxTurns(effectiveAccessLevel, options.maxTurns),
    pathToClaudeCodeExecutable: options.binaryPath,
    settingSources: ['user', 'project', 'local'] as ('user' | 'project' | 'local')[],
    includePartialMessages: true,
    // Force the normal logged-in Claude Code path instead of inheriting
    // shell-level Anthropic/API routing env that can silently burn API credits.
    env: createClaudeCodeSubscriptionEnv(process.env),
  }
  applyClaudePermissionOptions(queryOptions, permissionMode)
  applyClaudeContextWindowOption(queryOptions, options.contextWindow)
  applyClaudeToolOptions(queryOptions, resolvedTools)
  applyClaudeSpawnerOption(queryOptions, shouldWrapWindowsCmdShim)

  return queryOptions
}

function applyClaudeContextWindowOption(
  queryOptions: ClaudeCodeQueryOptions,
  contextWindow: string | undefined,
): void {
  if (contextWindow?.trim().toLowerCase() !== '1m') {
    return
  }

  queryOptions.betas = [
    ...new Set([...(queryOptions.betas ?? []), CLAUDE_ONE_M_CONTEXT_BETA]),
  ]
}

function applyClaudePermissionOptions(
  queryOptions: ClaudeCodeQueryOptions,
  permissionMode: ClaudeCodeQueryOptions['permissionMode'],
): void {
  if (permissionMode !== undefined) {
    queryOptions.permissionMode = permissionMode
  }
  if (permissionMode === 'bypassPermissions') {
    queryOptions.allowDangerouslySkipPermissions = true
  }
}

function applyClaudeToolOptions(
  queryOptions: ClaudeCodeQueryOptions,
  resolvedTools: string[] | undefined,
): void {
  if (resolvedTools !== undefined) {
    queryOptions.allowedTools = resolvedTools
  }
  if (Array.isArray(resolvedTools) && resolvedTools.length === 0) {
    queryOptions.tools = []
  }
}

function applyClaudeSpawnerOption(
  queryOptions: ClaudeCodeQueryOptions,
  shouldWrapWindowsCmdShim: boolean,
): void {
  if (shouldWrapWindowsCmdShim) {
    queryOptions.spawnClaudeCodeProcess = createWindowsCmdShimSpawner()
  }
}

async function runClaudeCodeSession(
  session: AsyncIterable<unknown>,
  options: ClaudeCodeExecutionOptions,
  state: ClaudeCodeSessionState,
  effectiveAccessLevel: ClaudeCodeAccessLevel,
): Promise<void> {
  for await (const message of session) {
    if (options.abortController.signal.aborted) break

    handleClaudeSessionMessage(
      message,
      state,
      effectiveAccessLevel,
      options.debug,
      options.onDelta,
    )
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function applyContextUsage(
  state: ClaudeCodeSessionState,
  contextUsage: { totalTokens: number; maxTokens: number },
): void {
  if (contextUsage.totalTokens <= 0 && contextUsage.maxTokens <= 0) {
    return
  }

  state.tokenUsage = {
    inputTokens: state.tokenUsage?.inputTokens ?? 0,
    outputTokens: state.tokenUsage?.outputTokens ?? 0,
    contextTokens: contextUsage.totalTokens,
    contextLimit: contextUsage.maxTokens,
  }
}

async function updateClaudeContextUsage(
  session: ClaudeSdkSession,
  state: ClaudeCodeSessionState,
): Promise<void> {
  try {
    const contextUsage = await session.getContextUsage()
    applyContextUsage(state, contextUsage)
  } catch (err) {
    const message = errorMessage(err)
    if (!message.includes('ProcessTransport is not ready for writing')) {
      log.warn('[claude-code-provider] Failed to fetch context usage:', err)
    }
  }
}

function closeClaudeSession(session: ClaudeSdkSession): void {
  try {
    session.close()
  } catch {
    // Already closed or process already exited.
  }
}

function handleClaudeExecutionError(
  error: unknown,
  options: ClaudeCodeExecutionOptions,
): void {
  if (options.abortController.signal.aborted) {
    options.onDelta?.({ type: 'status', status: 'cancelled' })
    return
  }

  log.error('[claude-code-provider] Stream error:', error)
  options.onDelta?.({ type: 'status', status: 'failed' })
  throw error
}

export async function executeClaudeCode(
  options: ClaudeCodeExecutionOptions,
): Promise<LocalAiExecutionResult> {
  const query = await loadClaudeSdkQuery()

  const effectiveAccessLevel =
    options.accessLevel ?? DEFAULT_CLAUDE_CODE_ACCESS_LEVEL
  const queryOptions = buildClaudeCodeQueryOptions(options, effectiveAccessLevel)

  // Each turn runs a fresh Claude Code session. The agent-runtime tracks the
  // full conversation (including tool calls + their results) in session.messages,
  // and the adapter serializes that transcript into the prompt — so a fresh
  // session sees the same context a resumed one would, without the failure
  // modes of session-id staleness, error-subtype interpretation, or transcript
  // duplication on resume + replay.
  const state: ClaudeCodeSessionState = {
    output: '',
    streamedOutput: false,
    sessionId: undefined,
    resumeCursor: undefined,
    tokenUsage: undefined,
  }

  options.onDelta?.({ type: 'status', status: 'started' })
  let session: ClaudeSdkSession | undefined

  try {
    session = query({
      prompt: options.prompt,
      options: queryOptions,
    })
    await runClaudeCodeSession(session, options, state, effectiveAccessLevel)
    if (!options.abortController.signal.aborted) {
      await updateClaudeContextUsage(session, state)
    }
  } catch (err: unknown) {
    handleClaudeExecutionError(err, options)
  } finally {
    if (session !== undefined) {
      closeClaudeSession(session)
    }
  }

  return {
    output: state.output,
    sessionId: state.sessionId,
    resumeCursor: state.resumeCursor,
    tokenUsage: state.tokenUsage,
  }
}
