import { spawn, spawnSync } from 'child_process'
import os from 'os'
import readline from 'readline'
import log from 'electron-log'
import type { ChildProcess } from 'child_process'
import type { Readable } from 'stream'
import type { LocalAiExecutionResult, LocalAiStreamDelta } from './types'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env'
import { createCommandInvocation, resolveOpenCodeWindowsBinary } from './cli-binary-resolution'
import {
  normalizeAccessLevel,
  type AccessLevel,
  DEFAULT_ACCESS_LEVEL,
} from './composer'

export interface OpenCodeDebugRecorder {
  recordEvent(stage: string, data: Record<string, unknown>): void
  recordAnomaly(stage: string, data: Record<string, unknown>): void
}

export interface OpenCodeExecutionOptions {
  prompt: string
  binaryPath: string
  abortController: AbortController
  cwd?: string
  model?: string
  accessLevel?: AccessLevel
  traitValues?: Record<string, string | boolean>
  opencodeArgs?: string[]
  onDelta?: (delta: LocalAiStreamDelta) => void
  debug?: OpenCodeDebugRecorder
}

const MAX_OUTPUT_LENGTH = 50_000
type OpenCodeAssistantDelta = { type: 'text' | 'reasoning'; text: string }
interface OpenCodeExecutionState {
  output: string
  rawStdout: string
  nonJsonStdout: string
  parsedJsonLineCount: number
  stderr: string
  jsonErrorMessage?: string
  sessionId?: string
  tokenUsage?: LocalAiExecutionResult['tokenUsage']
  previousTextByPartId: Map<string, string>
  wasAborted: boolean
}

type AppendOpenCodeOutput = (text: string) => void
type OpenCodeChildProcess = ChildProcess & {
  stdout: Readable
  stderr: Readable
}
const INPUT_TOKEN_FIELDS = ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'input'] as const
const OUTPUT_TOKEN_FIELDS = ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'output'] as const
const CONTEXT_TOKEN_FIELDS = ['contextTokens', 'context_tokens', 'totalTokens', 'total_tokens', 'total'] as const
const CONTEXT_LIMIT_FIELDS = ['contextLimit', 'context_limit', 'modelContextWindow', 'model_context_window'] as const
const ERROR_MESSAGE_FIELDS = ['message', 'description', 'reason'] as const

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      // Fall through to direct kill.
    }
  }
  child.kill()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }

  return value
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  return trimmed
}

function firstNumberField(record: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const value = asNumber(record[field])
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function firstStringField(record: Record<string, unknown> | undefined, fields: readonly string[]): string | undefined {
  if (record === undefined) {
    return undefined
  }

  for (const field of fields) {
    const value = asNonEmptyString(record[field])
    if (value !== undefined) {
      return value
    }
  }

  return undefined
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  if (record === undefined || typeof record[field] !== 'string') {
    return undefined
  }

  return record[field]
}

function createOpenCodePermissionEnv(accessLevel: AccessLevel): Record<string, string> {
  if (accessLevel === 'full-access') {
    return {}
  }

  const deny = 'deny'
  const allow = 'allow'

  if (accessLevel === 'supervised') {
    return {
      OPENCODE_PERMISSION: JSON.stringify({
        '*': deny,
        read: deny,
        glob: deny,
        grep: deny,
        bash: deny,
        edit: deny,
        webfetch: deny,
        websearch: deny,
        codesearch: deny,
        external_directory: deny,
        task: deny,
        todowrite: deny,
        lsp: deny,
        skill: deny,
        question: allow,
      }),
    }
  }

  return {
    OPENCODE_PERMISSION: JSON.stringify({
      read: allow,
      glob: allow,
      grep: allow,
      edit: allow,
      bash: deny,
      webfetch: deny,
      websearch: deny,
      codesearch: deny,
      external_directory: deny,
      task: deny,
      question: allow,
    }),
  }
}

function buildOpenCodePrompt(prompt: string, accessLevel: AccessLevel): string {
  if (accessLevel === 'full-access') {
    return prompt
  }

  let guardrails = [
    'You are executing inside BitSentry auto-accept-edits mode.',
    'Do not run shell commands, browse the web, or access external directories.',
    'Use only safe local read/edit style capabilities if the provider permits them.',
  ]
  if (accessLevel === 'supervised') {
    guardrails = [
      'You are executing inside BitSentry prompt-only mode.',
      'Do not run shell commands, edit files, browse the web, or call external tools.',
      'Respond only with text based on the prompt and supplied context.',
    ]
  }

  return [...guardrails, '', prompt].join('\n')
}

function getOpenCodeVariant(traitValues?: Record<string, string | boolean>): string | undefined {
  const effort = traitValues?.effort
  if (typeof effort !== 'string') {
    return undefined
  }

  const variant = effort.trim()
  if (variant.length === 0) {
    return undefined
  }

  return variant
}

function extractSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  for (const key of ['sessionID', 'sessionId', 'session_id']) {
    if (typeof record[key] === 'string') return record[key]
  }
  for (const raw of Object.values(record)) {
    const nested = extractSessionId(raw)
    if (nested !== undefined) return nested
  }
  return undefined
}

function findNestedTokenUsage(record: Record<string, unknown>): LocalAiExecutionResult['tokenUsage'] | undefined {
  for (const raw of Object.values(record)) {
    const nested = extractTokenUsage(raw)
    if (nested !== undefined) return nested
  }

  return undefined
}

function createTokenUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
  contextTokens: number | undefined,
  contextLimit: number | undefined,
): LocalAiExecutionResult['tokenUsage'] | undefined {
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    contextTokens === undefined &&
    contextLimit === undefined
  ) {
    return undefined
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    contextTokens,
    contextLimit,
  }
}

function extractTokenUsage(value: unknown): LocalAiExecutionResult['tokenUsage'] | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const usage = asRecord(record.usage) ?? asRecord(record.tokenUsage) ?? record
  const inputTokens = firstNumberField(usage, INPUT_TOKEN_FIELDS)
  const outputTokens = firstNumberField(usage, OUTPUT_TOKEN_FIELDS)
  const contextTokens = firstNumberField(usage, CONTEXT_TOKEN_FIELDS)
  const contextLimit = firstNumberField(usage, CONTEXT_LIMIT_FIELDS)
  return createTokenUsage(inputTokens, outputTokens, contextTokens, contextLimit) ?? findNestedTokenUsage(record)
}

function getPartStreamKind(part: Record<string, unknown> | undefined): OpenCodeAssistantDelta['type'] | undefined {
  if (part?.type === 'text') return 'text'
  if (part?.type === 'reasoning') return 'reasoning'
  return undefined
}

function getPartTextDelta(
  part: Record<string, unknown> | undefined,
  previousTextByPartId: Map<string, string>,
): OpenCodeAssistantDelta | undefined {
  if (part === undefined || typeof part.text !== 'string') return undefined

  const streamKind = getPartStreamKind(part)
  if (streamKind === undefined) {
    return undefined
  }

  const partId = stringField(part, 'id')
  if (partId === undefined || partId.length === 0) {
    return { type: streamKind, text: part.text }
  }

  const previousText = previousTextByPartId.get(partId) ?? ''
  previousTextByPartId.set(partId, part.text)
  if (part.text.startsWith(previousText)) {
    return { type: streamKind, text: part.text.slice(previousText.length) }
  }
  return { type: streamKind, text: part.text }
}

function extractMessagePartDelta(
  properties: Record<string, unknown> | undefined,
  part: Record<string, unknown> | undefined,
): OpenCodeAssistantDelta | undefined {
  if (typeof properties?.delta !== 'string') {
    return undefined
  }

  const deltaPart = asRecord(properties.part) ?? part
  const streamKind = getPartStreamKind(deltaPart)
  if (streamKind === undefined) {
    return undefined
  }

  return { type: streamKind, text: properties.delta }
}

function updatePreviousPartText(
  partId: string,
  updatedPart: Record<string, unknown> | undefined,
  delta: string,
  previousTextByPartId: Map<string, string>,
): void {
  if (typeof updatedPart?.text === 'string') {
    previousTextByPartId.set(partId, updatedPart.text)
    return
  }

  previousTextByPartId.set(
    partId,
    `${previousTextByPartId.get(partId) ?? ''}${delta}`,
  )
}

function extractUpdatedPartDelta(
  properties: Record<string, unknown> | undefined,
  previousTextByPartId: Map<string, string>,
): OpenCodeAssistantDelta | undefined {
  const updatedPart = asRecord(properties?.part)
  if (typeof properties?.delta !== 'string') {
    return getPartTextDelta(updatedPart, previousTextByPartId)
  }

  const streamKind = getPartStreamKind(updatedPart)
  if (streamKind === undefined) {
    return undefined
  }

  const partId = stringField(updatedPart, 'id')
  if (partId !== undefined && partId.length > 0) {
    updatePreviousPartText(partId, updatedPart, properties.delta, previousTextByPartId)
  }

  return { type: streamKind, text: properties.delta }
}

function extractOpenCodeAssistantDelta(
  value: unknown,
  previousTextByPartId: Map<string, string>,
): OpenCodeAssistantDelta | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined

  const type = stringField(record, 'type') ?? ''
  const part = asRecord(record.part)
  if (type === 'text') {
    return getPartTextDelta(part, previousTextByPartId)
  }

  const properties = asRecord(record.properties)
  if (type === 'message.part.delta') {
    return extractMessagePartDelta(properties, part)
  }

  if (type === 'message.part.updated') {
    return extractUpdatedPartDelta(properties, previousTextByPartId)
  }

  return undefined
}

function extractOpenCodeErrorDetail(value: unknown): string | undefined {
  const direct = asNonEmptyString(value)
  if (direct !== undefined) return direct

  const record = asRecord(value)
  if (record === undefined) return undefined

  const message = firstStringField(record, ERROR_MESSAGE_FIELDS)
  if (message !== undefined) return message

  const data = asRecord(record.data)
  const dataMessage = firstStringField(data, ERROR_MESSAGE_FIELDS)
  if (dataMessage !== undefined) return dataMessage

  const nestedError = extractOpenCodeErrorDetail(record.error)
  if (nestedError !== undefined) return nestedError

  const nestedCause = extractOpenCodeErrorDetail(record.cause)
  if (nestedCause !== undefined) return nestedCause

  return asNonEmptyString(record.name)
}

function extractOpenCodeErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined

  const type = stringField(record, 'type') ?? ''
  if (type !== 'error' && type !== 'session.error') {
    return undefined
  }

  const properties = asRecord(record.properties)
  for (const candidate of [
    record.error,
    record.message,
    record.data,
    properties?.error,
    properties,
  ]) {
    const detail = extractOpenCodeErrorDetail(candidate)
    if (detail !== undefined) {
      return detail
    }
  }

  return undefined
}

function appendOpenCodeJsonError(state: OpenCodeExecutionState, errorMessage: string): void {
  if (state.jsonErrorMessage === undefined) {
    state.jsonErrorMessage = errorMessage
    return
  }

  state.jsonErrorMessage = `${state.jsonErrorMessage}\n${errorMessage}`
}

function handleOpenCodeAssistantDelta(
  assistantDelta: OpenCodeAssistantDelta | undefined,
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
  appendOutput: AppendOpenCodeOutput,
  accessLevel: AccessLevel,
): void {
  if (assistantDelta === undefined || assistantDelta.text.length === 0) {
    return
  }

  if (assistantDelta.type === 'text') {
    appendOutput(assistantDelta.text)
  } else {
    options.onDelta?.({ type: 'reasoning', text: assistantDelta.text })
  }

  options.debug?.recordEvent('opencode.delta_received', {
    provider: 'opencode',
    accessLevel,
    sessionId: state.sessionId ?? null,
    deltaKind: assistantDelta.type,
    deltaLength: assistantDelta.text.length,
    accumulatedLength: state.output.length,
  })
}

function handleParsedOpenCodeLine(
  parsed: unknown,
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
  appendOutput: AppendOpenCodeOutput,
  accessLevel: AccessLevel,
): void {
  state.parsedJsonLineCount += 1
  state.sessionId = state.sessionId ?? extractSessionId(parsed)

  const nextTokenUsage = extractTokenUsage(parsed)
  if (nextTokenUsage !== undefined) {
    state.tokenUsage = nextTokenUsage
    options.onDelta?.({ type: 'token_usage', tokenUsage: nextTokenUsage })
  }

  const errorMessage = extractOpenCodeErrorMessage(parsed)
  if (errorMessage !== undefined) {
    appendOpenCodeJsonError(state, errorMessage)
  }

  handleOpenCodeAssistantDelta(
    extractOpenCodeAssistantDelta(parsed, state.previousTextByPartId),
    state,
    options,
    appendOutput,
    accessLevel,
  )
}

function handleOpenCodeStdoutLine(
  line: string,
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
  appendOutput: AppendOpenCodeOutput,
  accessLevel: AccessLevel,
): void {
  state.rawStdout += `${line}\n`
  const trimmed = line.trim()
  if (trimmed.length === 0) return

  try {
    handleParsedOpenCodeLine(
      JSON.parse(trimmed) as unknown,
      state,
      options,
      appendOutput,
      accessLevel,
    )
  } catch {
    state.nonJsonStdout += `${line}\n`
    appendOutput(`${line}\n`)
  }
}

function buildOpenCodeArgs(
  options: OpenCodeExecutionOptions,
  cwd: string,
  accessLevel: AccessLevel,
): string[] {
  const args = [...(options.opencodeArgs ?? []), 'run', '--format', 'json', '--dir', cwd]
  if (options.model !== undefined && options.model.length > 0) {
    args.push('--model', options.model)
  }

  const variant = getOpenCodeVariant(options.traitValues)
  if (variant !== undefined) {
    args.push('--variant', variant)
  }

  if (accessLevel === 'full-access') {
    args.push('--dangerously-skip-permissions')
  }

  args.push(buildOpenCodePrompt(options.prompt, accessLevel))
  return args
}

function createOpenCodeExecutionState(): OpenCodeExecutionState {
  return {
    output: '',
    rawStdout: '',
    nonJsonStdout: '',
    parsedJsonLineCount: 0,
    stderr: '',
    previousTextByPartId: new Map<string, string>(),
    wasAborted: false,
  }
}

function createAppendOpenCodeOutput(
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
): AppendOpenCodeOutput {
  return (text: string): void => {
    if (text.length === 0) return
    if (state.output.length >= MAX_OUTPUT_LENGTH) return

    state.output += text
    if (state.output.length > MAX_OUTPUT_LENGTH) {
      state.output = state.output.slice(0, MAX_OUTPUT_LENGTH)
    }
    options.onDelta?.({ type: 'text', text })
  }
}

function createOpenCodeProcess(
  options: OpenCodeExecutionOptions,
  cwd: string,
  accessLevel: AccessLevel,
): OpenCodeChildProcess {
  const binaryPath = resolveOpenCodeWindowsBinary(options.binaryPath)
  const invocation = createCommandInvocation(
    binaryPath,
    buildOpenCodeArgs(options, cwd, accessLevel),
  )

  const child = spawn(invocation.command, invocation.args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...createCodingAgentsProcessEnv(process.env),
      ...createOpenCodePermissionEnv(accessLevel),
    },
  })

  return child
}

async function waitForOpenCodeExit(
  child: OpenCodeChildProcess,
  abortSignal: AbortSignal,
  onAbort: () => void,
  stdoutLines: readline.Interface,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => { resolve(code); })
  }).finally(() => {
    abortSignal.removeEventListener('abort', onAbort)
    stdoutLines.close()
  })
}

function createOpenCodeAbortHandler(
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
  child: OpenCodeChildProcess,
): () => void {
  return () => {
    state.wasAborted = true
    options.onDelta?.({ type: 'status', status: 'cancelled' })
    killProcessTree(child)
  }
}

function buildOpenCodeResult(
  state: OpenCodeExecutionState,
  exitCode: number | null,
): LocalAiExecutionResult {
  return {
    output: state.output,
    sessionId: state.sessionId,
    exitCode: exitCode ?? undefined,
    tokenUsage: state.tokenUsage,
  }
}

function buildAbortedOpenCodeResult(
  state: OpenCodeExecutionState,
  exitCode: number | null,
): LocalAiExecutionResult {
  return {
    output: state.output,
    sessionId: state.sessionId,
    exitCode: exitCode ?? -1,
    tokenUsage: state.tokenUsage,
  }
}

function getOpenCodeFailureDetail(state: OpenCodeExecutionState): string {
  if (state.jsonErrorMessage !== undefined) {
    return state.jsonErrorMessage
  }

  const stderrDetail = state.stderr.trim()
  if (stderrDetail.length > 0) {
    return stderrDetail
  }

  return 'unknown error'
}

function recordOpenCodeCompletionAnomaly(
  state: OpenCodeExecutionState,
  accessLevel: AccessLevel,
  debug: OpenCodeDebugRecorder | undefined,
): void {
  if (
    state.output.trim().length === 0 &&
    state.parsedJsonLineCount === 0 &&
    state.rawStdout.trim().length > 0
  ) {
    state.output = state.nonJsonStdout.trim().slice(0, MAX_OUTPUT_LENGTH)
    debug?.recordAnomaly('opencode.completed_without_stream_deltas', {
      provider: 'opencode',
      accessLevel,
      sessionId: state.sessionId ?? null,
      finalTextLength: state.output.length,
    })
    return
  }

  if (state.output.trim().length === 0 && state.parsedJsonLineCount > 0) {
    debug?.recordAnomaly('opencode.completed_without_text_events', {
      provider: 'opencode',
      accessLevel,
      sessionId: state.sessionId ?? null,
      jsonLineCount: state.parsedJsonLineCount,
    })
  }
}

function wireOpenCodeProcess(
  child: OpenCodeChildProcess,
  state: OpenCodeExecutionState,
  options: OpenCodeExecutionOptions,
  appendOutput: AppendOpenCodeOutput,
  accessLevel: AccessLevel,
): {
  stdoutLines: readline.Interface
  onAbort: () => void
} {
  const stdoutLines = readline.createInterface({ input: child.stdout })
  stdoutLines.on('line', (line) => {
    if (state.wasAborted) return
    handleOpenCodeStdoutLine(line, state, options, appendOutput, accessLevel)
  })

  child.stderr.on('data', (chunk: Buffer) => {
    state.stderr += chunk.toString('utf8')
  })

  const onAbort = createOpenCodeAbortHandler(state, options, child)
  options.abortController.signal.addEventListener('abort', onAbort, { once: true })
  return { stdoutLines, onAbort }
}

function finalizeOpenCodeResult(
  state: OpenCodeExecutionState,
  exitCode: number | null,
  options: OpenCodeExecutionOptions,
  accessLevel: AccessLevel,
): LocalAiExecutionResult {
  if (state.wasAborted) {
    return buildAbortedOpenCodeResult(state, exitCode)
  }

  if (exitCode !== 0) {
    options.onDelta?.({ type: 'status', status: 'failed' })
    throw new Error(`OpenCode exited with code ${String(exitCode)}: ${getOpenCodeFailureDetail(state)}`)
  }

  recordOpenCodeCompletionAnomaly(state, accessLevel, options.debug)
  options.onDelta?.({ type: 'status', status: 'completed' })
  return buildOpenCodeResult(state, exitCode)
}

export async function executeOpenCode(
  options: OpenCodeExecutionOptions,
): Promise<LocalAiExecutionResult> {
  if (options.abortController.signal.aborted) {
    return { output: '', exitCode: -1 }
  }

  const cwd = options.cwd ?? os.tmpdir()
  const accessLevel = normalizeAccessLevel(options.accessLevel ?? DEFAULT_ACCESS_LEVEL)
  const child = createOpenCodeProcess(options, cwd, accessLevel)
  const state = createOpenCodeExecutionState()
  const appendOutput = createAppendOpenCodeOutput(state, options)
  const { stdoutLines, onAbort } = wireOpenCodeProcess(
    child,
    state,
    options,
    appendOutput,
    accessLevel,
  )
  options.onDelta?.({ type: 'status', status: 'started' })

  const exitCode = await waitForOpenCodeExit(
    child,
    options.abortController.signal,
    onAbort,
    stdoutLines,
  )

  return finalizeOpenCodeResult(state, exitCode, options, accessLevel)
}
