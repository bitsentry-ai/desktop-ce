import os from 'os'
import path from 'path'
import { CursorAcpClient, type CursorJsonRpcId } from './cursor-acp-client'
import type { LocalAiExecutionResult, LocalAiStreamDelta } from './types'
import { codingAgentsLogger as log } from './logger'
import {
  DEFAULT_ACCESS_LEVEL,
  normalizeAccessLevel,
  type AccessLevel,
} from './composer'

export interface CodingAgentDebugRecorder {
  recordEvent(stage: string, data: Record<string, unknown>): void
  recordAnomaly(stage: string, data: Record<string, unknown>): void
}

export interface CursorExecutionOptions {
  prompt: string
  binaryPath: string
  abortController: AbortController
  cwd?: string
  model?: string
  accessLevel?: AccessLevel
  traitValues?: Record<string, string | boolean>
  onDelta?: (delta: LocalAiStreamDelta) => void
  debug?: CodingAgentDebugRecorder
}

type CursorToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other'

type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

interface CursorPermissionOption {
  kind: PermissionOptionKind
  optionId: string
  name?: string
}

interface CursorPermissionResponse {
  outcome:
    | { outcome: 'cancelled' }
    | { outcome: 'selected'; optionId: string }
}

interface CursorExecutionState {
  output: string
  sessionId: string | undefined
}

const MAX_OUTPUT_LENGTH = 50_000
const CURSOR_SETUP_TIMEOUT_MS = 15_000
const READ_ONLY_TOOL_KINDS = new Set<CursorToolKind>(['read', 'search', 'think'])
const EDIT_TOOL_KINDS = new Set<CursorToolKind>(['edit', 'delete', 'move'])
const TEXTY_TOOL_CONTENT_TYPES = new Set(['content', 'text', 'markdown', 'stdout', 'stderr'])
const CURSOR_TOOL_KINDS: readonly CursorToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]
const CURSOR_TOOL_KIND_NAMES = new Set<string>(CURSOR_TOOL_KINDS)
const TOOL_KIND_PATTERNS: Array<{ kind: CursorToolKind; pattern: RegExp }> = [
  { kind: 'read', pattern: /\b(read|cat|view|open|list|ls)\b/ },
  { kind: 'search', pattern: /\b(search|grep|find|glob|rg)\b/ },
  { kind: 'think', pattern: /\b(think|plan|reason)\b/ },
  { kind: 'edit', pattern: /\b(edit|write|create|patch|update|modify|replace)\b/ },
  { kind: 'delete', pattern: /\b(delete|remove|unlink|rm)\b/ },
  { kind: 'move', pattern: /\b(move|rename|mv)\b/ },
  { kind: 'fetch', pattern: /\b(fetch|web|url|http)\b/ },
  { kind: 'execute', pattern: /\b(run|exec|execute|bash|shell|terminal|command|cmd|powershell)\b/ },
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  return []
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  return undefined
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function appendCursorStderrTail(message: string, stderrTail: string): string {
  const trimmedTail = stderrTail.trim()
  if (trimmedTail === '' || message.includes(trimmedTail)) return message
  return `${message}\nCursor stderr:\n${trimmedTail}`
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs / 1000)}s`))
    }, timeoutMs)

    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        if (error instanceof Error) {
          reject(error)
          return
        }

        reject(new Error(String(error)))
      },
    )
  })
}

function isCursorToolKind(value: unknown): value is CursorToolKind {
  return typeof value === 'string' && CURSOR_TOOL_KIND_NAMES.has(value)
}

function normalizePermissionOptions(value: unknown): CursorPermissionOption[] {
  return asArray(value)
    .map((raw) => {
      const record = asRecord(raw)
      if (record === undefined) return null
      const optionId = asString(record.optionId)
      const kind = record.kind
      if (optionId === undefined || !isPermissionOptionKind(kind)) return null
      const option: CursorPermissionOption = {
        optionId,
        kind,
      }
      const name = asString(record.name)
      if (name !== undefined) {
        option.name = name
      }
      return option
    })
    .filter((option): option is CursorPermissionOption => option !== null)
}

function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return (
    value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always'
  )
}

function inferToolKind(toolCall: Record<string, unknown> | undefined): CursorToolKind {
  if (isCursorToolKind(toolCall?.kind)) {
    return toolCall.kind
  }

  const searchable = getToolSearchText(toolCall)
  for (const { kind, pattern } of TOOL_KIND_PATTERNS) {
    if (pattern.test(searchable)) return kind
  }

  return 'other'
}

function getToolSearchText(toolCall: Record<string, unknown> | undefined): string {
  return [
    stringifyToolSearchValue(toolCall?.title),
    stringifyToolSearchValue(toolCall?.rawInput),
    stringifyToolSearchValue(toolCall?.rawOutput),
  ].join('\n').toLowerCase()
}

function stringifyToolSearchValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return ''
}

function canAllowTool(accessLevel: AccessLevel, toolKind: CursorToolKind): boolean {
  if (accessLevel === 'supervised') {
    return false
  }

  if (accessLevel === 'full-access') {
    return true
  }

  if (READ_ONLY_TOOL_KINDS.has(toolKind)) {
    return true
  }

  return EDIT_TOOL_KINDS.has(toolKind)
}

function chooseOption(
  options: CursorPermissionOption[],
  allow: boolean,
): CursorPermissionOption | undefined {
  let preferredKinds: PermissionOptionKind[] = ['reject_once', 'reject_always']
  if (allow) {
    preferredKinds = ['allow_once', 'allow_always']
  }

  for (const kind of preferredKinds) {
    const option = options.find((candidate) => candidate.kind === kind)
    if (option !== undefined) return option
  }

  return undefined
}

export function chooseCursorPermissionResponse(
  requestParams: unknown,
  accessLevel: AccessLevel,
  isAborted = false,
): CursorPermissionResponse {
  if (isAborted) {
    return { outcome: { outcome: 'cancelled' } }
  }

  const params = asRecord(requestParams)
  const toolCall = asRecord(params?.toolCall)
  const toolKind = inferToolKind(toolCall)
  const options = normalizePermissionOptions(params?.options)
  const selected = chooseOption(options, canAllowTool(accessLevel, toolKind))

  if (selected === undefined) {
    return { outcome: { outcome: 'cancelled' } }
  }

  return {
    outcome: {
      outcome: 'selected',
      optionId: selected.optionId,
    },
  }
}

function extractTextContent(value: unknown): string | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined

  return (
    extractTypedText(record) ??
    extractResourceText(record.resource) ??
    extractContentText(record.content)
  )
}

function extractTypedText(record: Record<string, unknown>): string | undefined {
  if (typeof record.text !== 'string') return undefined
  if (record.type === 'text') return record.text
  if (typeof record.type === 'string' && TEXTY_TOOL_CONTENT_TYPES.has(record.type)) return record.text
  return undefined
}

function extractResourceText(value: unknown): string | undefined {
  const resource = asRecord(value)
  if (typeof resource?.text === 'string') return resource.text
  return undefined
}

function extractContentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value

  const nestedContent = extractTextContent(value)
  if (nestedContent !== undefined && nestedContent !== '') return nestedContent

  return undefined
}

function extractToolContentText(value: unknown): string | undefined {
  const parts = asArray(value)
    .map(extractTextContent)
    .filter((part): part is string => part !== undefined && part !== '')

  if (parts.length > 0) return parts.join('\n')
  return undefined
}

export function cursorDeltasFromSessionUpdate(params: unknown): LocalAiStreamDelta[] {
  const update = asRecord(asRecord(params)?.update)
  if (update === undefined) return []

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      return textDeltasFromUpdate(update.content, 'text')
    }

    case 'agent_thought_chunk': {
      return textDeltasFromUpdate(update.content, 'reasoning')
    }

    case 'tool_call': {
      return toolCallDeltasFromUpdate(update)
    }

    case 'tool_call_update': {
      return toolCallUpdateDeltasFromUpdate(update)
    }

    default:
      return []
  }
}

function textDeltasFromUpdate(
  content: unknown,
  type: 'text' | 'reasoning',
): LocalAiStreamDelta[] {
  const text = extractTextContent(content)
  if (text === undefined || text === '') return []
  return [{ type, text }]
}

function getToolName(update: Record<string, unknown>): string {
  return asString(update.title) ?? asString(update.kind) ?? 'Tool'
}

function toolCallDeltasFromUpdate(update: Record<string, unknown>): LocalAiStreamDelta[] {
  const toolName = getToolName(update)
  const deltas: LocalAiStreamDelta[] = []
  if (update.status === 'completed' || update.status === 'failed') {
    deltas.push({ type: 'tool_end', toolName, status: update.status })
  } else {
    deltas.push({ type: 'tool_start', toolName, status: 'started' })
  }
  addToolContentDelta(deltas, toolName, update.content)
  return deltas
}

function toolCallUpdateDeltasFromUpdate(update: Record<string, unknown>): LocalAiStreamDelta[] {
  const toolName = getToolName(update)
  const deltas: LocalAiStreamDelta[] = []
  addToolContentDelta(deltas, toolName, update.content)
  if (update.status === 'completed' || update.status === 'failed') {
    deltas.push({ type: 'tool_end', toolName, status: update.status })
  }
  return deltas
}

function addToolContentDelta(
  deltas: LocalAiStreamDelta[],
  toolName: string,
  content: unknown,
): void {
  const contentText = extractToolContentText(content)
  if (contentText !== undefined && contentText !== '') {
    deltas.push({ type: 'command_output', toolName, text: contentText })
  }
}

function extractSessionId(value: unknown): string | undefined {
  const record = asRecord(value)
  return asString(record?.sessionId)
}

function getModelConfigOptionId(sessionResult: unknown): string | undefined {
  return getConfigOptionId(sessionResult, isModelConfigOption)
}

function getConfigOptionId(
  sessionResult: unknown,
  predicate: (option: Record<string, unknown>) => boolean,
): string | undefined {
  const configOptions = asArray(asRecord(sessionResult)?.configOptions)
  for (const rawOption of configOptions) {
    const option = asRecord(rawOption)
    if (option === undefined) continue
    const id = asString(option.id)
    if (id !== undefined && predicate(option)) {
      return id
    }
  }
  return undefined
}

function isModelConfigOption(option: Record<string, unknown>): boolean {
  const category = asString(option.category)?.toLowerCase()
  const id = asString(option.id)?.toLowerCase()
  const name = asString(option.name)?.toLowerCase()
  return category === 'model' || id === 'model' || name?.includes('model') === true
}

function isEffortConfigOption(option: Record<string, unknown>): boolean {
  const category = asString(option.category)?.toLowerCase()
  const id = asString(option.id)?.toLowerCase()
  const name = asString(option.name)?.toLowerCase()
  return (
    category === 'effort' ||
    category === 'reasoning' ||
    id === 'effort' ||
    id === 'reasoning' ||
    id === 'thinking' ||
    name?.includes('effort') === true ||
    name?.includes('reasoning') === true ||
    name?.includes('thinking') === true
  )
}

function getEffortConfigOptionId(
  sessionResult: unknown,
  effort: string,
): string | undefined {
  const configOptions = asArray(asRecord(sessionResult)?.configOptions)
  for (const rawOption of configOptions) {
    const option = asRecord(rawOption)
    if (option === undefined || !isEffortConfigOption(option)) continue
    if (!selectConfigOptionHasValue(option, effort)) continue

    const id = asString(option.id)
    if (id !== undefined) return id
  }

  return undefined
}

function selectConfigOptionHasValue(
  option: Record<string, unknown>,
  value: string,
): boolean {
  if (option.type !== 'select') return false
  return optionValuesContain(asArray(option.options), value)
}

function optionValuesContain(rawValues: unknown[], expectedValue: string): boolean {
  for (const rawValue of rawValues) {
    const value = asRecord(rawValue)
    if (value === undefined) continue

    const nestedOptions = asArray(value.options)
    if (nestedOptions.length > 0) {
      if (optionValuesContain(nestedOptions, expectedValue)) return true
      continue
    }

    const optionValue =
      asString(value.value) ?? asString(value.modelId) ?? asString(value.id)
    if (optionValue === expectedValue) return true
  }

  return false
}

function collectConfigOptionModels(configOptions: unknown): Set<string> {
  const modelIds = new Set<string>()

  for (const rawOption of asArray(configOptions)) {
    addModelsFromConfigOption(modelIds, rawOption)
  }

  return modelIds
}

function addModelsFromConfigOption(modelIds: Set<string>, rawOption: unknown): void {
  const option = asRecord(rawOption)
  if (option === undefined || option.type !== 'select' || !isModelConfigOption(option)) return

  for (const rawValue of asArray(option.options)) {
    addModelIdsFromOptionValue(modelIds, rawValue)
  }
}

function addModelIdsFromOptionValue(modelIds: Set<string>, rawValue: unknown): void {
  const value = asRecord(rawValue)
  if (value === undefined) return

  const nestedOptions = asArray(value.options)
  if (nestedOptions.length > 0) {
    for (const rawNested of nestedOptions) {
      addModelIdFromRecord(modelIds, rawNested)
    }
    return
  }

  addModelIdFromRecord(modelIds, value)
}

function addModelIdFromRecord(modelIds: Set<string>, rawValue: unknown): void {
  const value = asRecord(rawValue)
  const modelId = asString(value?.value) ?? asString(value?.modelId) ?? asString(value?.id)
  if (modelId !== undefined) modelIds.add(modelId)
}

export function extractCursorModelIds(sessionResult: unknown): string[] {
  const result = asRecord(sessionResult)
  const modelIds = new Set<string>()

  addAvailableModels(modelIds, result?.models)
  for (const modelId of collectConfigOptionModels(result?.configOptions)) {
    modelIds.add(modelId)
  }

  return [...modelIds]
}

function addAvailableModels(modelIds: Set<string>, rawModels: unknown): void {
  const models = asRecord(rawModels)
  for (const rawModel of asArray(models?.availableModels)) {
    addModelIdFromRecord(modelIds, rawModel)
  }
}

function isAbortSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function appendCursorOutput(state: CursorExecutionState, text: string): void {
  if (text === '') return

  if (state.output.length >= MAX_OUTPUT_LENGTH) return

  state.output += text
  if (state.output.length > MAX_OUTPUT_LENGTH) {
    state.output = state.output.slice(0, MAX_OUTPUT_LENGTH)
  }
}

function handleCursorSessionNotification(
  notification: { method: string; params: unknown },
  options: CursorExecutionOptions,
  accessLevel: AccessLevel,
  state: CursorExecutionState,
): void {
  if (notification.method !== 'session/update') return

  for (const delta of cursorDeltasFromSessionUpdate(notification.params)) {
    handleCursorDelta(delta, options, accessLevel, state)
  }
}

function handleCursorDelta(
  delta: LocalAiStreamDelta,
  options: CursorExecutionOptions,
  accessLevel: AccessLevel,
  state: CursorExecutionState,
): void {
  if (delta.type === 'text' && typeof delta.text === 'string' && delta.text !== '') {
    appendCursorOutput(state, delta.text)
    options.debug?.recordEvent('cursor.delta_received', {
      provider: 'cursor',
      accessLevel,
      sessionId: state.sessionId ?? null,
      deltaLength: delta.text.length,
      accumulatedLength: state.output.length,
    })
  }

  options.onDelta?.(delta)
}

function cancelCursorSession(client: CursorAcpClient, state: CursorExecutionState): void {
  if (state.sessionId !== undefined) {
    client.cancelSession(state.sessionId)
  }
}

async function initializeCursorClient(
  client: CursorAcpClient,
  options: { authenticate?: boolean } = {},
): Promise<void> {
  const initializeResult = await withTimeout(
    client.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: {
        name: 'bitsentry_desktop',
        title: 'BitSentry SuperTerminal',
        version: '0.1.0',
      },
    }),
    CURSOR_SETUP_TIMEOUT_MS,
    'Cursor ACP initialize',
  )

  const authMethods = asArray(asRecord(initializeResult)?.authMethods)
  const hasCursorLogin = authMethods.some((rawMethod) => {
    const method = asRecord(rawMethod)
    return method?.id === 'cursor_login'
  })

  if (hasCursorLogin && options.authenticate !== false) {
    await withTimeout(
      client.sendRequest('authenticate', { methodId: 'cursor_login' }),
      CURSOR_SETUP_TIMEOUT_MS,
      'Cursor ACP authenticate',
    )
  }
}

async function setCursorModel(
  client: CursorAcpClient,
  sessionResult: unknown,
  sessionId: string,
  model: string | undefined,
): Promise<void> {
  if (model === undefined || model === '') return

  const modelConfigOptionId = getModelConfigOptionId(sessionResult)
  if (modelConfigOptionId !== undefined) {
    try {
      await withTimeout(
        client.sendRequest('session/set_config_option', {
          sessionId,
          configId: modelConfigOptionId,
          value: model,
        }),
        CURSOR_SETUP_TIMEOUT_MS,
        'Cursor ACP session/set_config_option',
      )
      return
    } catch (err) {
      log.warn('[cursor-provider] Failed to set model via config option:', err)
    }
  }

  try {
    await withTimeout(
      client.sendRequest('session/set_model', { sessionId, modelId: model }),
      CURSOR_SETUP_TIMEOUT_MS,
      'Cursor ACP session/set_model',
    )
    return
  } catch (err) {
    log.warn('[cursor-provider] Failed to set model via session/set_model:', err)
  }

  await withTimeout(
    client.sendRequest('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: model,
    }),
    CURSOR_SETUP_TIMEOUT_MS,
    'Cursor ACP session/set_config_option',
  )
}

async function setCursorEffort(
  client: CursorAcpClient,
  sessionResult: unknown,
  sessionId: string,
  effort: string | boolean | undefined,
): Promise<void> {
  if (typeof effort !== 'string' || effort === '') return

  const effortConfigOptionId = getEffortConfigOptionId(sessionResult, effort)
  if (effortConfigOptionId === undefined) return

  try {
    await withTimeout(
      client.sendRequest('session/set_config_option', {
        sessionId,
        configId: effortConfigOptionId,
        value: effort,
      }),
      CURSOR_SETUP_TIMEOUT_MS,
      'Cursor ACP session/set_config_option',
    )
  } catch (err) {
    log.warn('[cursor-provider] Failed to set effort via config option:', err)
  }
}

export async function listCursorModels(binaryPath: string): Promise<string[]> {
  const client = new CursorAcpClient(binaryPath, os.tmpdir())

  try {
    await client.start()
    await initializeCursorClient(client, { authenticate: false })
    const sessionResult = await withTimeout(
      client.sendRequest('session/new', {
        cwd: os.tmpdir(),
        mcpServers: [],
      }),
      CURSOR_SETUP_TIMEOUT_MS,
      'Cursor ACP session/new',
    )
    return extractCursorModelIds(sessionResult)
  } finally {
    client.kill()
  }
}

function createCursorAbortHandler(
  client: CursorAcpClient,
  options: CursorExecutionOptions,
  state: CursorExecutionState,
): () => void {
  return () => {
    options.onDelta?.({ type: 'status', status: 'cancelled' })
    cancelCursorSession(client, state)
    setTimeout(() => { client.kill(); }, 2000)
  }
}

function registerCursorServerRequestHandler(
  client: CursorAcpClient,
  options: CursorExecutionOptions,
  accessLevel: AccessLevel,
): void {
  client.on('serverRequest', (request: { id: CursorJsonRpcId; method: string; params: unknown }) => {
    if (request.method === 'session/request_permission') {
      client.respondToServerRequest(
        request.id,
        chooseCursorPermissionResponse(
          request.params,
          accessLevel,
          isAbortSignalAborted(options.abortController.signal),
        ),
      )
      return
    }

    client.respondToServerRequestError(request.id, 'Method not supported')
  })
}

async function createCursorSession(client: CursorAcpClient, cwd: string): Promise<unknown> {
  return withTimeout(
    client.sendRequest('session/new', {
      cwd,
      mcpServers: [],
    }),
    CURSOR_SETUP_TIMEOUT_MS,
    'Cursor ACP session/new',
  )
}

function requireCursorSessionId(sessionResult: unknown): string {
  const sessionId = extractSessionId(sessionResult)
  if (sessionId === undefined || sessionId === '') {
    throw new Error('Cursor ACP session/new response did not include sessionId')
  }

  return sessionId
}

async function sendCursorPrompt(
  client: CursorAcpClient,
  sessionId: string,
  prompt: string,
): Promise<Record<string, unknown> | undefined> {
  return asRecord(await client.sendRequest('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text: prompt,
      },
    ],
  }))
}

function cursorPromptResult(
  promptResult: Record<string, unknown> | undefined,
  options: CursorExecutionOptions,
  accessLevel: AccessLevel,
  state: CursorExecutionState,
): LocalAiExecutionResult {
  const stopReason = asString(promptResult?.stopReason)
  if (stopReason === 'cancelled') {
    options.onDelta?.({ type: 'status', status: 'cancelled' })
    return { output: state.output, sessionId: state.sessionId, exitCode: -1 }
  }

  if (stopReason !== undefined && stopReason !== 'end_turn') {
    options.debug?.recordAnomaly('cursor.completed_with_non_end_turn_stop_reason', {
      provider: 'cursor',
      accessLevel,
      sessionId: state.sessionId,
      stopReason,
    })
  }

  options.onDelta?.({ type: 'status', status: 'completed' })
  return { output: state.output, sessionId: state.sessionId }
}

async function runCursorSession(
  client: CursorAcpClient,
  cwd: string,
  options: CursorExecutionOptions,
  accessLevel: AccessLevel,
  state: CursorExecutionState,
): Promise<LocalAiExecutionResult> {
  options.onDelta?.({ type: 'status', status: 'started' })
  await client.start()
  await initializeCursorClient(client)

  const sessionResult = await createCursorSession(client, cwd)
  state.sessionId = requireCursorSessionId(sessionResult)

  await setCursorModel(client, sessionResult, state.sessionId, options.model)
  await setCursorEffort(client, sessionResult, state.sessionId, options.traitValues?.effort)

  const promptResult = await sendCursorPrompt(client, state.sessionId, options.prompt)
  return cursorPromptResult(promptResult, options, accessLevel, state)
}

export async function executeCursor(
  options: CursorExecutionOptions,
): Promise<LocalAiExecutionResult> {
  if (isAbortSignalAborted(options.abortController.signal)) {
    return { output: '', exitCode: -1 }
  }

  const cwd = path.resolve(options.cwd ?? os.tmpdir())
  const accessLevel = normalizeAccessLevel(options.accessLevel ?? DEFAULT_ACCESS_LEVEL)
  const client = new CursorAcpClient(options.binaryPath, cwd)
  const state: CursorExecutionState = { output: '', sessionId: undefined }
  const onAbort = createCursorAbortHandler(client, options, state)

  options.abortController.signal.addEventListener('abort', onAbort, { once: true })

  client.on('notification', (notification: { method: string; params: unknown }) => {
    handleCursorSessionNotification(notification, options, accessLevel, state)
  })
  registerCursorServerRequestHandler(client, options, accessLevel)

  try {
    return await runCursorSession(client, cwd, options, accessLevel, state)
  } catch (err: unknown) {
    if (isAbortSignalAborted(options.abortController.signal)) {
      options.onDelta?.({ type: 'status', status: 'cancelled' })
      return { output: state.output, sessionId: state.sessionId, exitCode: -1 }
    }

    log.error('[cursor-provider] Execution error:', err)
    options.onDelta?.({ type: 'status', status: 'failed' })
    throw new Error(appendCursorStderrTail(getErrorMessage(err), client.getStderrTail()))
  } finally {
    options.abortController.signal.removeEventListener('abort', onAbort)
    client.kill()
  }
}
