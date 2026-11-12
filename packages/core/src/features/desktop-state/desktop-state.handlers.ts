import { customerReportDisplayText } from '../plugins/customer-reports'
import { logFilterConfigSchema, type LogFilterConfig } from '../runbooks'
import {
  normalizeRunbookActionType,
  normalizeRunbookIdleTimeout,
} from '../runbooks/desktop-runbook.types'
import { parseExecutionSnapshot } from '../runbooks/desktop-runbook-result.store'

type RpcHandler = (payload: unknown) => Promise<unknown>
type RunbookExecutionRecord = NonNullable<ReturnType<typeof parseExecutionSnapshot>>
type DesktopStateRow = Record<string, unknown>

interface DesktopStateCountTable {
  count(args: Record<string, unknown>): Promise<number>
}

interface DesktopStateFindManyTable {
  findMany(args: Record<string, unknown>): Promise<DesktopStateRow[]>
}

interface DesktopStateDeleteManyTable {
  deleteMany(args: Record<string, unknown>): Promise<unknown>
}

interface DesktopStateCreateTable {
  create(args: { data: Record<string, unknown> }): Promise<DesktopStateRow>
}

interface DesktopStateFindUniqueTable {
  findUnique(args: { where: Record<string, unknown> }): Promise<DesktopStateRow | null>
}

interface DesktopStateUpsertTable {
  upsert(args: {
    where: Record<string, unknown>
    update: Record<string, unknown>
    create: Record<string, unknown>
  }): Promise<DesktopStateRow>
}

type DesktopStateCollectionTable = DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable

export interface DesktopStateDatabase {
  legacyImportLedger: DesktopStateFindUniqueTable & DesktopStateUpsertTable
  incidentMessage: DesktopStateFindManyTable
  incidentThread: DesktopStateFindManyTable
  runbook:
    & DesktopStateCountTable
    & DesktopStateDeleteManyTable
    & DesktopStateCreateTable
    & DesktopStateFindManyTable
    & DesktopStateUpsertTable
  runbookAction: DesktopStateCollectionTable
  runbookVersion: DesktopStateDeleteManyTable
  investigationSession:
    & DesktopStateCountTable
    & DesktopStateDeleteManyTable
    & DesktopStateCreateTable
    & DesktopStateFindUniqueTable
    & DesktopStateFindManyTable
  investigationTraceEntry: DesktopStateCollectionTable
  investigationToolRun: DesktopStateCollectionTable
  investigationReport: DesktopStateCollectionTable
  $queryRawUnsafe<T extends DesktopStateRow = DesktopStateRow>(query: string): Promise<T[]>
  $executeRawUnsafe(query: string): Promise<unknown>
  $executeBatch(statements: BatchStatement[]): Promise<void>
}

type BatchStatement = { sql: string; parameters: (string | number | null)[] }

interface ToolCallRecord {
  toolCallId: string
  toolName: string
  state: 'running' | 'done' | 'failed'
  input?: Record<string, unknown>
  output?: string
  error?: string
}

interface IncidentThreadRecord {
  id: string
  title: string
  createdAt: string
  prompt: string
  state: string
  sessionId?: string
  archived?: boolean
  archivedAt?: string
  lastMessagePreview?: string | null
}

// Renderer chat messages are stored verbatim in "messageJson"; the summary
// columns are derived from them for readers that predate that column.
export type IncidentChatMessage = Record<string, unknown> & { kind: 'user' | 'agent' }

interface IncidentMessageColumns {
  text: string | null
  streamText: string | null
  toolCallsJson: string | null
  finalText: string | null
  status: string | null
  errorMsg: string | null
}

interface RunbookActionRecord {
  id: string
  type: 'shell' | 'llm' | 'http' | 'external_source' | 'plugin'
  title: string
  command?: string
  prompt?: string
  llmProviderKey?: 'groq' | 'kilocode' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'claude_code' | 'codex' | 'opencode' | 'cursor'
  llmModel?: string
  url?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?: Array<{ key: string; value: string }>
  body?: string
  query?: string
  sourceId?: string
  pluginId?: string
  pluginActionId?: string
  pluginInput?: string
  pluginAuth?: string
  logFilter?: LogFilterConfig
  parameters?: Array<{
    id: string
    key: string
    label?: string
    description?: string
    defaultValue?: string
    required?: boolean
    secure?: boolean
  }>
}

type RunbookParameterRecord = NonNullable<RunbookActionRecord['parameters']>[number]

interface RunbookRecord {
  id: string
  title: string
  description: string
  idleTimeout?: number
  revisionNumber: number
  actions: RunbookActionRecord[]
  createdAt: string
  updatedAt: string
}

interface StoredRunResult {
  id: string
  executionId?: string
  incidentThreadId?: string
  runbookId: string
  runbookTitle: string
  runbookRevisionNumber?: number
  runbookContextJson?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: string
  completedAt?: string
  prompt: string
}

interface ToolStep {
  toolCallId: string
  toolName: string
  state: 'running' | 'done' | 'failed'
  output?: string
  error?: string
}

interface ResultTraceMemory {
  execution: RunbookExecutionRecord | null
  text: string
  toolSteps: ToolStep[]
  report: string
}

interface DesktopProductStateSnapshot {
  runbooks: RunbookRecord[]
  results: StoredRunResult[]
  resultTraces: Record<string, ResultTraceMemory>
}

interface DesktopStatePayload extends Partial<DesktopProductStateSnapshot> {
  investigations?: unknown[]
  investigationTraces?: Record<string, unknown>
}

const PHASE1_IMPORT_KEY = 'phase1.localstorage.bootstrap'

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return {}
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value
  }

  return fallback
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  return undefined
}

function asIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}

function asNullableIsoString(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  return asIsoString(value)
}

function parseTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return undefined

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

function isAtLeastAsRecent(existing: unknown, incoming: unknown): boolean {
  const existingTimestamp = parseTimestamp(existing)
  const incomingTimestamp = parseTimestamp(incoming)
  return existingTimestamp !== undefined && incomingTimestamp !== undefined
    && existingTimestamp >= incomingTimestamp
}

function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim().length === 0) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }

  return undefined
}

function normalizeToolCall(value: unknown): ToolCallRecord | null {
  const item = asObject(value)
  const toolCallId = asString(item.toolCallId)
  const toolName = asString(item.toolName)
  const state = asString(item.state) as ToolCallRecord['state']
  if (toolCallId.length === 0 || toolName.length === 0) return null

  const record: ToolCallRecord = {
    toolCallId,
    toolName,
    state,
  }
  const input = asOptionalRecord(item.input)
  if (input !== undefined) {
    record.input = input
  }
  const output = asOptionalString(item.output)
  if (output !== undefined) {
    record.output = output
  }
  const error = asOptionalString(item.error)
  if (error !== undefined) {
    record.error = error
  }

  return record
}

function dedupeToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return []

  const deduped = new Map<string, ToolCallRecord>()

  for (const toolCall of value) {
    const normalized = normalizeToolCall(toolCall)
    if (normalized === null) continue

    deduped.set(normalized.toolCallId, normalized)
  }

  return [...deduped.values()]
}

function normalizeRunbookHeaders(value: unknown): Array<{ key: string; value: string }> | undefined {
  if (!Array.isArray(value)) return undefined

  const headers: Array<{ key: string; value: string }> = []
  for (const item of value) {
    const header = asObject(item)
    const key = asString(header.key).trim()
    if (key.length === 0) continue

    headers.push({
      key,
      value: asString(header.value),
    })
  }

  if (headers.length > 0) {
    return headers
  }

  return undefined
}

function normalizeRunbookParameter(raw: unknown): RunbookParameterRecord | null {
  const parameter = asObject(raw)
  const key = asString(parameter.key).trim()
  if (key.length === 0) return null

  let label = asString(parameter.label, key).trim()
  if (label.length === 0) {
    label = key
  }
  const secure = parameter.secure === true
  const normalized: RunbookParameterRecord = {
    id: asString(parameter.id, key),
    key,
    label,
  }
    if (typeof parameter.description === 'string') {
    normalized.description = parameter.description
    }
    if (typeof parameter.defaultValue === 'string' && !secure) {
    normalized.defaultValue = parameter.defaultValue
    }
    if (typeof parameter.required === 'boolean') {
    normalized.required = parameter.required
    }
    if (secure) {
    normalized.secure = true
  }

  return normalized
}

function normalizeRunbookParameters(
  value: unknown,
): RunbookActionRecord['parameters'] | undefined {
  if (!Array.isArray(value)) return undefined

  const parameters: RunbookParameterRecord[] = []
  for (const item of value) {
    const parameter = normalizeRunbookParameter(item)
    if (parameter !== null) {
      parameters.push(parameter)
    }
  }

  if (parameters.length > 0) {
    return parameters
  }

  return undefined
}

function normalizeRunbookLogFilter(value: unknown): RunbookActionRecord['logFilter'] | undefined {
  let parsedValue = value
  if (typeof value === 'string') {
    parsedValue = safeJsonParse<unknown>(value, undefined)
  }
  const parsed = logFilterConfigSchema.safeParse(parsedValue)
  if (parsed.success) {
    return parsed.data
  }

  return undefined
}

/** The thread columns a saveThread patch sets, keyed by column name. */
function incidentThreadPatchColumns(patch: Record<string, unknown>, now: string): Map<string, string | null> {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(patch, key)
  const columns = new Map<string, string | null>()
  if (has('title')) columns.set('title', asString(patch.title, 'New Incident'))
  if (has('prompt')) columns.set('prompt', asString(patch.prompt))
  if (has('state')) columns.set('state', asString(patch.state, 'IDLE'))
  if (has('sessionId')) columns.set('sessionId', asOptionalNonEmptyString(patch.sessionId) ?? null)
  if (has('createdAt')) columns.set('createdAt', asIsoString(patch.createdAt))
  if (has('archivedAt') || has('archived')) {
    const archivedAt = asNullableIsoString(patch.archivedAt)
    const archived = has('archivedAt') ? archivedAt != null : patch.archived === true
    columns.set('archivedAt', archived ? (archivedAt ?? now) : null)
  }
  if (has('lastMessagePreview')) {
    columns.set('lastMessagePreview', normalizePreviewText(asOptionalString(patch.lastMessagePreview)))
  }
  return columns
}

/**
 * The ON CONFLICT assignment for one patched column. createdAt is set on insert
 * only; archiving keeps the first archive time; a missing preview keeps the
 * stored one.
 */
function incidentThreadColumnUpdate(column: string): string[] {
  if (column === 'createdAt') return []
  if (column === 'archivedAt') {
    return ['"archivedAt"=CASE WHEN excluded."archivedAt" IS NULL THEN NULL ELSE COALESCE("IncidentThread"."archivedAt", excluded."archivedAt") END']
  }
  if (column === 'lastMessagePreview') {
    return ['"lastMessagePreview"=COALESCE(excluded."lastMessagePreview", "IncidentThread"."lastMessagePreview")']
  }
  return [`"${column}"=excluded."${column}"`]
}

function asOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined
  }

  return value
}

function latestIterationText(value: Record<string, unknown>): string {
  if (!Array.isArray(value.iterations)) return ''

  const latestIteration = asObject(value.iterations[value.iterations.length - 1])
  return asString(latestIteration.text)
}

function normalizeAgentFinalText(value: Record<string, unknown>, fallbackText: string): string | null {
  if (value.finalText != null) {
    return asString(value.finalText)
  }

  if (fallbackText.length > 0 && asString(value.status, 'thinking') === 'done') {
    return fallbackText
  }

  return null
}

function normalizeChatMessage(raw: unknown): IncidentChatMessage | null {
  const value = asObject(raw)
  if (value.kind === 'user' || value.kind === 'agent') return value as IncidentChatMessage
  return null
}

function incidentMessageColumns(message: IncidentChatMessage): IncidentMessageColumns {
  if (message.kind === 'user') {
    return { text: asString(message.text), streamText: null, toolCallsJson: null, finalText: null, status: null, errorMsg: null }
  }

  const fallbackText = latestIterationText(message)
  return {
    text: null,
    streamText: asString(message.streamText, fallbackText),
    toolCallsJson: JSON.stringify(dedupeToolCalls(message.toolCalls)),
    finalText: normalizeAgentFinalText(message, fallbackText),
    status: asString(message.status, 'thinking'),
    errorMsg: asOptionalString(message.errorMsg) ?? null,
  }
}

function normalizePreviewText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = customerReportDisplayText(value).replace(/\s+/g, ' ').trim()
  if (normalized.length > 0) {
    return normalized
  }

  return null
}

function getIncidentPreviewFromMessages(messages: IncidentChatMessage[]): string | null {
  let lastMessage: IncidentChatMessage | undefined
  if (messages.length > 0) {
    lastMessage = messages[messages.length - 1]
  }
  if (lastMessage === undefined) return null
  if (lastMessage.kind === 'user') {
    return normalizePreviewText(asString(lastMessage.text))
  }

  return normalizePreviewText(
    asString(lastMessage.finalText) || latestIterationText(lastMessage) || asString(lastMessage.streamText),
  )
}

function serializeIncidentMessage(message: IncidentChatMessage): string {
  return JSON.stringify(message)
}

function normalizeRevisionNumber(value: unknown): number {
  const revisionNumber = Number(value)
  if (Number.isFinite(revisionNumber)) {
    return Math.max(1, revisionNumber)
  }

  return 1
}

function normalizeRunbookAction(raw: unknown): RunbookActionRecord | null {
  const item = asObject(raw)
  const actionId = asString(item.id)
  const type = normalizeRunbookActionType(item.type) as RunbookActionRecord['type']
  if (actionId.length === 0) return null

  const action: RunbookActionRecord = {
    id: actionId,
    type,
    title: asString(item.title),
    command: asOptionalString(item.command),
    prompt: asOptionalString(item.prompt),
    llmProviderKey: asOptionalString(item.llmProviderKey) as RunbookActionRecord['llmProviderKey'],
    llmModel: asOptionalString(item.llmModel),
    url: asOptionalString(item.url),
    method: asOptionalString(item.method) as RunbookActionRecord['method'],
    headers: normalizeRunbookHeaders(item.headers),
    body: asOptionalString(item.body),
    query: asOptionalString(item.query),
    sourceId: asOptionalString(item.sourceId),
    logFilter: normalizeRunbookLogFilter(item.logFilter),
    parameters: normalizeRunbookParameters(item.parameters),
  }
  if (type === 'plugin') {
    action.pluginId = asOptionalString(item.pluginId)
    action.pluginActionId = asOptionalString(item.pluginActionId)
    action.pluginInput = asOptionalString(item.pluginInput)
    action.pluginAuth = asOptionalString(item.pluginAuth)
  }

  return action
}

function normalizeRunbook(raw: unknown): RunbookRecord | null {
  const value = asObject(raw)
  const id = asString(value.id)
  if (id.length === 0) return null

  const actions: RunbookActionRecord[] = []
  if (Array.isArray(value.actions)) {
    for (const rawAction of value.actions) {
      const action = normalizeRunbookAction(rawAction)
      if (action !== null) {
        actions.push(action)
      }
    }
  }

  return {
    id,
    title: asString(value.title, 'New Runbook'),
    description: asString(value.description),
    idleTimeout: normalizeRunbookIdleTimeout(value.idleTimeout),
    revisionNumber: normalizeRevisionNumber(value.revisionNumber),
    actions,
    createdAt: asIsoString(value.createdAt),
    updatedAt: asIsoString(value.updatedAt),
  }
}

function normalizeResult(raw: unknown): StoredRunResult | null {
  const value = asObject(raw)
  const id = asString(value.id)
  if (id.length === 0) return null

  let runbookRevisionNumber: number | undefined
  if (value.runbookRevisionNumber != null && Number.isFinite(Number(value.runbookRevisionNumber))) {
    runbookRevisionNumber = Math.max(1, Number(value.runbookRevisionNumber))
  }

  return {
    id,
    executionId: asOptionalString(value.executionId),
    incidentThreadId: asOptionalString(value.incidentThreadId),
    runbookId: asString(value.runbookId),
    runbookTitle: asString(value.runbookTitle, 'Runbook'),
    runbookRevisionNumber,
    runbookContextJson: asOptionalString(value.runbookContextJson),
    status: asString(value.status, 'failed') as StoredRunResult['status'],
    startedAt: asIsoString(value.startedAt),
    completedAt: asNullableIsoString(value.completedAt),
    prompt: asString(value.prompt),
  }
}

function normalizeResultTraces(
  value: unknown,
): Record<string, ResultTraceMemory> {
  const input = asObject(value)
  const output: Record<string, ResultTraceMemory> = {}

  for (const [key, rawTrace] of Object.entries(input)) {
    const trace = asObject(rawTrace)
    const execution = normalizeTraceExecution(trace.execution)
    const toolSteps = normalizeToolSteps(trace.toolSteps)

    output[key] = {
      execution,
      text: asString(trace.text),
      toolSteps,
      report: asString(trace.report),
    }
  }

  return output
}

function normalizeTraceExecution(value: unknown): RunbookExecutionRecord | null {
  if (value !== null && typeof value === 'object') {
    return value as RunbookExecutionRecord
  }

  return null
}

function normalizeToolStep(value: unknown): ToolStep | null {
  const item = asObject(value)
  const toolCallId = asString(item.toolCallId)
  const toolName = asString(item.toolName)
  const state = asString(item.state) as ToolStep['state']
  if (toolCallId.length === 0 || toolName.length === 0) return null

  const step: ToolStep = {
    toolCallId,
    toolName,
    state,
  }
  const output = asOptionalString(item.output)
  if (output !== undefined) {
    step.output = output
  }
  const error = asOptionalString(item.error)
  if (error !== undefined) {
    step.error = error
  }

  return step
}

function normalizeToolSteps(value: unknown): ToolStep[] {
  if (!Array.isArray(value)) return []

  const toolSteps: ToolStep[] = []
  for (const item of value) {
    const step = normalizeToolStep(item)
    if (step !== null) {
      toolSteps.push(step)
    }
  }

  return toolSteps
}

function emptyTrace(): ResultTraceMemory {
  return { execution: null, text: '', toolSteps: [], report: '' }
}

function payloadResults(payload: DesktopStatePayload): unknown[] {
  if (Array.isArray(payload.results)) return payload.results
  if (Array.isArray(payload.investigations)) return payload.investigations
  return []
}

function payloadResultTraces(payload: DesktopStatePayload): unknown {
  if (payload.resultTraces !== undefined && typeof payload.resultTraces === 'object') return payload.resultTraces
  if (payload.investigationTraces !== undefined && typeof payload.investigationTraces === 'object') {
    return payload.investigationTraces
  }
  return {}
}

function normalizeRunbooksList(value: unknown): RunbookRecord[] {
  if (!Array.isArray(value)) return []

  const runbooks: RunbookRecord[] = []
  for (const item of value) {
    const runbook = normalizeRunbook(item)
    if (runbook !== null) {
      runbooks.push(runbook)
    }
  }

  return runbooks
}

function normalizeResultsList(value: unknown[]): StoredRunResult[] {
  const results: StoredRunResult[] = []
  for (const item of value) {
    const result = normalizeResult(item)
    if (result !== null) {
      results.push(result)
    }
  }

  return results
}

function hasImportPayload(
  runbooks: RunbookRecord[],
  results: StoredRunResult[],
  resultTraces: Record<string, ResultTraceMemory>,
): boolean {
  return runbooks.length > 0 || hasResultPayload(results, resultTraces)
}

function hasResultPayload(
  results: StoredRunResult[],
  resultTraces: Record<string, ResultTraceMemory>,
): boolean {
  return results.length > 0 || Object.keys(resultTraces).length > 0
}

function serializeNullableJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  return JSON.stringify(value)
}

function nullableValue<T>(value: T | undefined): T | null {
  if (value === undefined) {
    return null
  }

  return value
}

// Messages keep the id they were created with; older rows fall back to the row
// id, or to threadId + sortOrder, so renderer reconciliation has a stable key.
function normalizeIncidentMessageRow(rawMessage: unknown): IncidentChatMessage {
  const message = asObject(rawMessage)
  const id = asString(message.id) || `${asString(message.threadId)}:${String(message.sortOrder)}`
  const stored = normalizeChatMessage(safeJsonParse<unknown>(message.messageJson, null))
  if (stored !== null) return typeof stored.id === 'string' && stored.id.length > 0 ? stored : { ...stored, id }
  if (asString(message.kind) === 'user') {
    return {
      id,
      kind: 'user',
      text: asString(message.text),
    }
  }

  return {
    id,
    kind: 'agent',
    streamText: asString(message.streamText),
    toolCalls: dedupeToolCalls(safeJsonParse(message.toolCallsJson, [])),
    finalText: nullableString(message.finalText),
    status: asString(message.status, 'thinking'),
    errorMsg: asOptionalString(message.errorMsg),
  }
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return asString(value)
}

function addRunbookAction(
  actionsByRunbookId: Map<string, RunbookActionRecord[]>,
  rawAction: unknown,
): void {
  const action = asObject(rawAction)
  const runbookId = asString(action.runbookId)
  if (runbookId.length === 0) return

  const list = actionsByRunbookId.get(runbookId) ?? []
  const type = normalizeRunbookActionType(action.type) as RunbookActionRecord['type']
  const runbookAction: RunbookActionRecord = {
    id: asString(action.id),
    type,
    title: asString(action.title),
    command: asOptionalString(action.command),
    prompt: asOptionalString(action.prompt),
    llmProviderKey: asOptionalString(action.llmProviderKey) as RunbookActionRecord['llmProviderKey'],
    llmModel: asOptionalString(action.llmModel),
    url: asOptionalString(action.url),
    method: asOptionalString(action.method) as RunbookActionRecord['method'],
    headers: normalizeRunbookHeaders(safeJsonParse(action.headersJson, [])),
    body: asOptionalString(action.body),
    query: asOptionalString(action.query),
    sourceId: asOptionalString(action.sourceId),
    logFilter: normalizeRunbookLogFilter(action.logFilterJson),
    parameters: normalizeRunbookParameters(safeJsonParse(action.parametersJson, [])),
  }
  if (type === 'plugin') {
    runbookAction.pluginId = asOptionalString(action.sourceId)
    runbookAction.pluginActionId = asOptionalString(action.query)
    runbookAction.pluginInput = asOptionalString(action.body)
    runbookAction.pluginAuth = asOptionalString(action.url)
    runbookAction.sourceId = undefined
    runbookAction.query = undefined
    runbookAction.body = undefined
    runbookAction.url = undefined
  }
  list.push(runbookAction)
  actionsByRunbookId.set(runbookId, list)
}

function addEmptyTrace(resultTraces: Record<string, ResultTraceMemory>, rawResult: unknown): void {
  const result = asObject(rawResult)
  resultTraces[asString(result.id)] = emptyTrace()
}

function setTraceText(resultTraces: Record<string, ResultTraceMemory>, rawTrace: unknown): void {
  const trace = asObject(rawTrace)
  const resultId = asString(trace.investigationSessionId)
  if (resultId.length === 0) return

  const entry = resultTraces[resultId] ?? emptyTrace()
  entry.text = asString(trace.content)
  resultTraces[resultId] = entry
}

function addTraceToolRun(resultTraces: Record<string, ResultTraceMemory>, rawRun: unknown): void {
  const run = asObject(rawRun)
  const resultId = asString(run.investigationSessionId)
  if (resultId.length === 0) return

  const entry = resultTraces[resultId] ?? emptyTrace()
  const step = normalizeToolStep({
    toolCallId: run.toolCallId,
    toolName: run.toolName,
    state: run.state,
    output: run.output,
    error: run.error,
  })
  if (step !== null) {
    entry.toolSteps.push(step)
  }
  resultTraces[resultId] = entry
}

function setTraceReport(resultTraces: Record<string, ResultTraceMemory>, rawReport: unknown): void {
  const report = asObject(rawReport)
  const resultId = asString(report.investigationSessionId)
  if (resultId.length === 0) return

  const entry = resultTraces[resultId] ?? emptyTrace()
  entry.report = asString(report.content)
  resultTraces[resultId] = entry
}

function normalizeIncidentRow(rawIncident: unknown): IncidentThreadRecord {
  const incident = asObject(rawIncident)
  const id = asString(incident.id)
  const prompt = asString(incident.prompt)
  return {
    id,
    title: asString(incident.title, 'New Incident'),
    createdAt: asIsoString(incident.createdAt),
    prompt,
    state: asString(incident.state, 'IDLE'),
    sessionId: asOptionalNonEmptyString(incident.sessionId),
    archived: incident.archivedAt != null,
    archivedAt: asNullableIsoString(incident.archivedAt),
    lastMessagePreview: normalizePreviewText(asOptionalString(incident.lastMessagePreview)) ?? normalizePreviewText(prompt),
  }
}

function normalizeRunbookRow(
  rawRunbook: unknown,
  actionsByRunbookId: Map<string, RunbookActionRecord[]>,
): RunbookRecord {
  const runbook = asObject(rawRunbook)
  const id = asString(runbook.id)
  return {
    id,
    title: asString(runbook.title, 'New Runbook'),
    description: asString(runbook.description),
    idleTimeout: normalizeRunbookIdleTimeout(runbook.idleTimeout),
    revisionNumber: normalizeRevisionNumber(runbook.revisionNumber),
    actions: actionsByRunbookId.get(id) ?? [],
    createdAt: asIsoString(runbook.createdAt),
    updatedAt: asIsoString(runbook.updatedAt),
  }
}

function normalizeResultRow(rawResult: unknown): StoredRunResult {
  const result = asObject(rawResult)
  let runbookRevisionNumber: number | undefined
  if (result.runbookRevisionNumber != null && Number.isFinite(Number(result.runbookRevisionNumber))) {
    runbookRevisionNumber = Math.max(1, Number(result.runbookRevisionNumber))
  }

  return {
    id: asString(result.id),
    executionId: asOptionalString(result.executionId),
    incidentThreadId: asOptionalString(result.incidentThreadId),
    runbookId: asString(result.runbookId),
    runbookTitle: asString(result.runbookTitle, 'Runbook'),
    runbookRevisionNumber,
    runbookContextJson: asOptionalString(result.runbookContextJson),
    status: asString(result.status, 'failed') as StoredRunResult['status'],
    startedAt: asIsoString(result.startedAt),
    completedAt: asNullableIsoString(result.completedAt),
    prompt: asString(result.prompt),
  }
}

function parseResultExecutionSnapshot(resultRows: unknown[], resultId: string): RunbookExecutionRecord | null {
  const row = resultRows.find((result) => asString(asObject(result).id) === resultId)
  const executionSnapshotJson = asOptionalString(asObject(row).executionSnapshotJson)
  if (executionSnapshotJson !== undefined && executionSnapshotJson.length > 0) {
    return parseExecutionSnapshot(executionSnapshotJson)
  }

  return null
}

function normalizeResultTraceEntries(
  resultRows: unknown[],
  resultTraces: Record<string, ResultTraceMemory>,
): Record<string, ResultTraceMemory> {
  return Object.fromEntries(
    Object.entries(resultTraces).map(([resultId, trace]) => {
      return [
        resultId,
        {
          ...trace,
          execution: parseResultExecutionSnapshot(resultRows, resultId),
        },
      ]
    }),
  )
}

class DesktopStateStore {
  constructor(private readonly db: DesktopStateDatabase) {}

  async bootstrap(payload: DesktopStatePayload): Promise<DesktopProductStateSnapshot> {
    const runbooks = normalizeRunbooksList(payload.runbooks)
    const results = normalizeResultsList(payloadResults(payload))
    const resultTraces = normalizeResultTraces(payloadResultTraces(payload))

    const importLedger = await this.db.legacyImportLedger.findUnique({
      where: { key: PHASE1_IMPORT_KEY },
    })

    if (importLedger === null) {
      await this.bootstrapFirstImport(runbooks, results, resultTraces)
    } else {
      await this.bootstrapExistingState(runbooks, results, resultTraces)
    }

    return this.readSnapshot()
  }

  private async bootstrapFirstImport(
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    if (hasImportPayload(runbooks, results, resultTraces)) {
      await this.replaceRunbooksForLegacyImport(runbooks)
      const existingInvestigationCount = await this.db.investigationSession.count({})
      if (existingInvestigationCount === 0 && hasResultPayload(results, resultTraces)) {
        await this.replaceResults(results, resultTraces)
      }
    }

    await this.recordLegacyImport(runbooks, results)
  }

  private async bootstrapExistingState(
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    const [existingRunbookCount, existingInvestigationCount] =
      await Promise.all([
        this.db.runbook.count({}),
        this.db.investigationSession.count({}),
      ])

    if (existingRunbookCount === 0 && runbooks.length > 0) {
      await this.replaceRunbooksForLegacyImport(runbooks)
    }

    if (existingInvestigationCount === 0 && hasResultPayload(results, resultTraces)) {
      await this.replaceResults(results, resultTraces)
    }
  }

  private async recordLegacyImport(
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
  ): Promise<void> {
    const payloadJson = JSON.stringify({
      runbooks: runbooks.length,
      results: results.length,
    })
    const importedAt = new Date().toISOString()
    await this.db.legacyImportLedger.upsert({
      where: { key: PHASE1_IMPORT_KEY },
      update: {
        importedAt,
        payloadJson,
      },
      create: {
        key: PHASE1_IMPORT_KEY,
        importedAt,
        payloadJson,
      },
    })
  }

  /** Incident threads without their messages, newest first. */
  async listIncidentThreads(): Promise<IncidentThreadRecord[]> {
    const rows = await this.db.incidentThread.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((row) => normalizeIncidentRow(row))
  }

  /**
   * Patches one thread's metadata with the fields present in `raw`, so a stale
   * caller cannot overwrite fields it did not change. A missing row is created
   * with defaults. Messages are left alone.
   */
  async saveThread(raw: unknown): Promise<{ ok: true }> {
    const patch = asObject(raw)
    const id = asString(patch.id)
    if (id.length === 0) throw new Error('Incident thread id is required')
    const now = new Date().toISOString()
    const present = incidentThreadPatchColumns(patch, now)
    const row: Record<string, string | null> = {
      title: 'New Incident', prompt: '', state: 'IDLE', sessionId: null, createdAt: now,
      archivedAt: null, lastMessagePreview: null, ...Object.fromEntries(present),
    }
    const updates = ['"updatedAt"=excluded."updatedAt"', ...[...present.keys()].flatMap(incidentThreadColumnUpdate)]
    await this.db.$executeBatch([{
      sql: `INSERT INTO "IncidentThread" ("id","title","prompt","state","sessionId","createdAt","updatedAt","archivedAt","lastMessagePreview")
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET ${updates.join(',')}`,
      parameters: [id, row.title, row.prompt, row.state, row.sessionId, row.createdAt, now, row.archivedAt, row.lastMessagePreview],
    }])
    return { ok: true }
  }

  async syncRunbooks(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    const runbooks = normalizeRunbooksList(payload.runbooks)
    await this.mergeRunbooksFromRenderer(runbooks)
    return { ok: true, count: runbooks.length }
  }

  async syncResults(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    const results = normalizeResultsList(payloadResults(payload))
    const resultTraces = normalizeResultTraces(payloadResultTraces(payload))
    await this.importMissingResults(results, resultTraces)
    return { ok: true, count: results.length }
  }

  private async importMissingResults(
    results: StoredRunResult[],
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    if (results.length === 0) return
    const existingRows = await this.db.investigationSession.findMany({
      where: { id: { in: results.map((result) => result.id) } },
    })
    const existingIds = new Set(existingRows.map((row) => row.id))
    for (const result of results) {
      if (existingIds.has(result.id)) continue

      const trace = resultTraces[result.id] ?? emptyTrace()
      await this.replaceResult(result, trace, false)
    }
  }

  /**
   * Legacy localStorage bootstrap is the sole caller allowed to replace the
   * entire runbook collection. Periodic renderer synchronization must merge
   * so a stale snapshot cannot erase main-process writes.
   */
  private async replaceRunbooksForLegacyImport(runbooks: RunbookRecord[]): Promise<void> {
    await this.db.runbookAction.deleteMany({})
    await this.db.runbookVersion.deleteMany({})
    await this.db.runbook.deleteMany({})

    for (const runbook of runbooks) {
      await this.replaceRunbook(runbook)
    }
  }

  private async mergeRunbooksFromRenderer(runbooks: RunbookRecord[]): Promise<void> {
    for (const runbook of runbooks) {
      const matchingRunbooks = await this.db.runbook.findMany({
        where: { id: runbook.id },
      })
      const existingRunbook = matchingRunbooks[0]

      // Explicit deletion creates a tombstone. A stale renderer snapshot must
      // never recreate that row, even if it is newer than the deletion.
      if (existingRunbook?.deletedAt != null) {
        continue
      }

      if (existingRunbook !== undefined && isAtLeastAsRecent(
        existingRunbook.updatedAt,
        runbook.updatedAt,
      )) {
        continue
      }

      const data = {
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        idleTimeout: runbook.idleTimeout ?? null,
        revisionNumber: runbook.revisionNumber,
        createdAt: runbook.createdAt,
        updatedAt: runbook.updatedAt,
      }
      await this.db.runbook.upsert({
        where: { id: runbook.id },
        update: data,
        create: data,
      })

      await this.db.runbookAction.deleteMany({
        where: { runbookId: runbook.id },
      })
      for (let index = 0; index < runbook.actions.length; index += 1) {
        await this.replaceRunbookAction(runbook, runbook.actions[index], index)
      }
    }
  }

  private async replaceRunbook(runbook: RunbookRecord): Promise<void> {
    await this.db.runbook.create({
      data: {
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        idleTimeout: runbook.idleTimeout ?? null,
        revisionNumber: runbook.revisionNumber,
        createdAt: runbook.createdAt,
        updatedAt: runbook.updatedAt,
      },
    })

    for (let index = 0; index < runbook.actions.length; index += 1) {
      await this.replaceRunbookAction(runbook, runbook.actions[index], index)
    }
  }

  private async replaceRunbookAction(
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    index: number,
  ): Promise<void> {
    let url = action.url
    let body = action.body
    let query = action.query
    let sourceId = action.sourceId
    if (action.type === 'plugin') {
      url =
        typeof action.pluginAuth === 'string' && action.pluginAuth.trim().length > 0
          ? action.pluginAuth
          : undefined
      body = action.pluginInput
      query = action.pluginActionId
      sourceId = action.pluginId
    }

    await this.db.runbookAction.create({
      data: {
        id: action.id,
        runbookId: runbook.id,
        sortOrder: index,
        type: normalizeRunbookActionType(action.type),
        title: action.title,
        command: nullableValue(action.command),
        prompt: nullableValue(action.prompt),
        llmProviderKey: nullableValue(action.llmProviderKey),
        llmModel: nullableValue(action.llmModel),
        url: nullableValue(url),
        method: nullableValue(action.method),
        headersJson: serializeNullableJson(action.headers),
        body: nullableValue(body),
        query: nullableValue(query),
        sourceId: nullableValue(sourceId),
        logFilterJson: serializeNullableJson(action.logFilter),
        parametersJson: serializeNullableJson(action.parameters),
        createdAt: runbook.updatedAt,
        updatedAt: runbook.updatedAt,
      },
    })
  }

  private async replaceResults(
    results: StoredRunResult[],
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    // The renderer mirror is a cache of what the UI has seen, never the
    // source of truth for a run. Execution-backed rows are owned by the
    // execution service, so this sync must not delete them or overwrite the
    // columns it maintains (status, completedAt, executionSnapshotJson).
    const existingRows = await this.db.investigationSession.findMany({})
    const ownedByExecution = new Set<string>()
    for (const row of existingRows) {
      const id = asString(row.id)
      if (id.length > 0 && asString(row.executionId).length > 0) {
        ownedByExecution.add(id)
      }
    }

    for (const result of results) {
      const trace = resultTraces[result.id] ?? emptyTrace()
      await this.replaceResult(result, trace, ownedByExecution.has(result.id))
    }
  }

  private async replaceResult(
    result: StoredRunResult,
    trace: ResultTraceMemory,
    executionOwned: boolean,
  ): Promise<void> {
    if (executionOwned) {
      // Row already exists and belongs to a real execution. Leave it and its
      // children untouched; the execution service keeps them current.
      return
    }

    await this.db.investigationSession.deleteMany({ where: { id: result.id } })
    await this.db.investigationToolRun.deleteMany({
      where: { investigationSessionId: result.id },
    })
    await this.db.investigationTraceEntry.deleteMany({
      where: { investigationSessionId: result.id },
    })
    await this.db.investigationReport.deleteMany({
      where: { investigationSessionId: result.id },
    })

    await this.db.investigationSession.create({
      data: {
        id: result.id,
        runbookId: result.runbookId,
        runbookVersionId: null,
        runbookTitle: result.runbookTitle,
        runbookRevisionNumber: result.runbookRevisionNumber ?? null,
        runbookContextJson: result.runbookContextJson ?? null,
        executionId: result.executionId ?? null,
        incidentThreadId: result.incidentThreadId ?? null,
        executionSnapshotJson: serializeNullableJson(trace.execution),
        status: result.status,
        startedAt: result.startedAt,
        completedAt: result.completedAt ?? null,
        prompt: result.prompt,
        createdAt: result.startedAt,
        updatedAt: result.completedAt ?? result.startedAt,
      },
    })

    await this.replaceResultTrace(result, trace)
    await this.replaceResultReport(result, trace)
    await this.replaceResultToolRuns(result, trace)
  }

  private async replaceResultTrace(result: StoredRunResult, trace: ResultTraceMemory): Promise<void> {
    await this.db.investigationTraceEntry.create({
      data: {
        id: `${result.id}:trace`,
        investigationSessionId: result.id,
        content: trace.text,
        createdAt: result.startedAt,
        updatedAt: result.completedAt ?? result.startedAt,
      },
    })
  }

  private async replaceResultReport(result: StoredRunResult, trace: ResultTraceMemory): Promise<void> {
    if (trace.report.length === 0) return

    await this.db.investigationReport.create({
      data: {
        id: `${result.id}:report`,
        investigationSessionId: result.id,
        content: trace.report,
        createdAt: result.startedAt,
        updatedAt: result.completedAt ?? result.startedAt,
      },
    })
  }

  private async replaceResultToolRuns(result: StoredRunResult, trace: ResultTraceMemory): Promise<void> {
    for (let index = 0; index < trace.toolSteps.length; index += 1) {
      const step = trace.toolSteps[index]
      await this.db.investigationToolRun.create({
        data: {
          id: `${result.id}:tool:${String(index)}`,
          investigationSessionId: result.id,
          sortOrder: index,
          toolCallId: step.toolCallId,
          toolName: step.toolName,
          state: step.state,
          output: step.output ?? null,
          error: step.error ?? null,
          createdAt: result.startedAt,
          updatedAt: result.completedAt ?? result.startedAt,
        },
      })
    }
  }

  private async readSnapshot(): Promise<DesktopProductStateSnapshot> {
    const [runbooks, runbookActions, resultRows, traceEntries, toolRuns, reports] =
      await Promise.all([
        this.db.runbook.findMany({
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.runbookAction.findMany({ orderBy: { sortOrder: 'asc' } }),
        this.db.investigationSession.findMany({ orderBy: { startedAt: 'desc' } }),
        this.db.investigationTraceEntry.findMany({}),
        this.db.investigationToolRun.findMany({ orderBy: { sortOrder: 'asc' } }),
        this.db.investigationReport.findMany({}),
      ])

    const runbookActionsByRunbookId = new Map<string, RunbookActionRecord[]>()
    for (const rawAction of runbookActions) {
      addRunbookAction(runbookActionsByRunbookId, rawAction)
    }

    const resultTraces: Record<string, ResultTraceMemory> = {}
    for (const rawResult of resultRows) {
      addEmptyTrace(resultTraces, rawResult)
    }

    for (const rawTrace of traceEntries) {
      setTraceText(resultTraces, rawTrace)
    }

    for (const rawRun of toolRuns) {
      addTraceToolRun(resultTraces, rawRun)
    }

    for (const rawReport of reports) {
      setTraceReport(resultTraces, rawReport)
    }

    return {
      runbooks: runbooks.map((runbook) => normalizeRunbookRow(runbook, runbookActionsByRunbookId)),
      results: resultRows.map((result) => normalizeResultRow(result)),
      resultTraces: normalizeResultTraceEntries(resultRows, resultTraces),
    }
  }
}

/** Loads one incident thread's persisted chat messages in display order. */
export async function loadIncidentThreadMessages(
  db: Pick<DesktopStateDatabase, 'incidentMessage'>,
  threadId: string,
): Promise<IncidentChatMessage[]> {
  const rows = await db.incidentMessage.findMany({ where: { threadId }, orderBy: { sortOrder: 'asc' } })
  return rows.map((row) => normalizeIncidentMessageRow(row))
}

// Message ids are unique across threads; an id owned by another thread is
// ignored rather than moved, so one thread's write never rewrites another's.
const MESSAGE_CONTENT_UPDATES = `"kind"=excluded."kind","text"=excluded."text",
        "streamText"=excluded."streamText","toolCallsJson"=excluded."toolCallsJson","finalText"=excluded."finalText",
        "status"=excluded."status","errorMsg"=excluded."errorMsg","messageJson"=excluded."messageJson","updatedAt"=excluded."updatedAt"`

function ensureIncidentThreadStatement(threadId: string, now: string): BatchStatement {
  // The agent can answer before the renderer saved a new thread's row.
  return {
    sql: `INSERT INTO "IncidentThread" ("id","title","prompt","state","createdAt","updatedAt")
      VALUES (?,'New Incident','','IDLE',?,?) ON CONFLICT("id") DO NOTHING`,
    parameters: [threadId, now, now],
  }
}

/**
 * Replaces one incident thread's messages in a single transaction. Rows are
 * keyed by message id, so unchanged messages are not rewritten. Only the agent
 * runtime, which owns the full list, calls this.
 */
export async function saveIncidentThreadMessages(
  db: Pick<DesktopStateDatabase, '$executeBatch'>,
  threadId: string,
  rawMessages: readonly unknown[],
): Promise<void> {
  if (threadId.length === 0) throw new Error('Incident thread id is required')
  const now = new Date().toISOString()
  const messages = rawMessages.map(normalizeChatMessage).filter((message) => message !== null)
  const rowIds: string[] = []
  const statements: BatchStatement[] = [ensureIncidentThreadStatement(threadId, now)]
  for (const [index, message] of messages.entries()) {
    const messageId = asString(message.id)
    const rowId = messageId.length > 0 && !rowIds.includes(messageId) ? messageId : `${threadId}:${String(index)}`
    rowIds.push(rowId)
    const columns = incidentMessageColumns(message)
    statements.push({
      sql: `INSERT INTO "IncidentMessage" ("id","threadId","sortOrder","kind","text","streamText","toolCallsJson","finalText","status","errorMsg","messageJson","createdAt","updatedAt")
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET
        "sortOrder"=excluded."sortOrder",${MESSAGE_CONTENT_UPDATES}
        WHERE "IncidentMessage"."threadId" = excluded."threadId"
          AND ("IncidentMessage"."messageJson" IS NOT excluded."messageJson" OR "IncidentMessage"."sortOrder" IS NOT excluded."sortOrder")`,
      parameters: [rowId, threadId, index, message.kind, columns.text, columns.streamText, columns.toolCallsJson,
        columns.finalText, columns.status, columns.errorMsg, serializeIncidentMessage(message), now, now],
    })
  }
  statements.push({
    sql: 'DELETE FROM "IncidentMessage" WHERE "threadId" = ? AND "id" NOT IN (SELECT value FROM json_each(?))',
    parameters: [threadId, JSON.stringify(rowIds)],
  }, {
    sql: 'UPDATE "IncidentThread" SET "lastMessagePreview" = ?, "updatedAt" = ? WHERE "id" = ?',
    parameters: [getIncidentPreviewFromMessages(messages), now, threadId],
  })
  await db.$executeBatch(statements)
}

/**
 * Appends messages after a thread's last stored message in one batch. Nothing
 * is deleted, so a renderer that has not loaded the history cannot drop it.
 */
export async function appendIncidentThreadMessages(
  db: Pick<DesktopStateDatabase, '$executeBatch'>,
  threadId: string,
  rawMessages: readonly unknown[],
): Promise<void> {
  if (threadId.length === 0) throw new Error('Incident thread id is required')
  const messages = rawMessages.map(normalizeChatMessage).filter((message) => message !== null)
  if (messages.length === 0) return
  const now = new Date().toISOString()
  const rowIds = new Set<string>()
  const statements: BatchStatement[] = [ensureIncidentThreadStatement(threadId, now)]
  for (const message of messages) {
    const messageId = asString(message.id)
    const rowId = messageId.length > 0 && !rowIds.has(messageId) ? messageId : `${threadId}:${crypto.randomUUID()}`
    rowIds.add(rowId)
    const columns = incidentMessageColumns(message)
    statements.push({
      sql: `INSERT INTO "IncidentMessage" ("id","threadId","sortOrder","kind","text","streamText","toolCallsJson","finalText","status","errorMsg","messageJson","createdAt","updatedAt")
        VALUES (?,?,(SELECT COALESCE(MAX("sortOrder"), -1) + 1 FROM "IncidentMessage" WHERE "threadId" = ?),?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT("id") DO UPDATE SET ${MESSAGE_CONTENT_UPDATES}
        WHERE "IncidentMessage"."threadId" = excluded."threadId" AND "IncidentMessage"."messageJson" IS NOT excluded."messageJson"`,
      parameters: [rowId, threadId, threadId, message.kind, columns.text, columns.streamText, columns.toolCallsJson,
        columns.finalText, columns.status, columns.errorMsg, serializeIncidentMessage(message), now, now],
    })
  }
  statements.push({
    sql: 'UPDATE "IncidentThread" SET "lastMessagePreview" = COALESCE(?, "lastMessagePreview"), "updatedAt" = ? WHERE "id" = ?',
    parameters: [getIncidentPreviewFromMessages(messages), now, threadId],
  })
  await db.$executeBatch(statements)
}

export function createDesktopStateHandlers(
  db: DesktopStateDatabase,
): Record<string, RpcHandler> {
  const store = new DesktopStateStore(db)

  return {
    'incidents:list': async () => {
      return store.listIncidentThreads()
    },
    'incidents:getThreadMessages': async (payload: unknown) => {
      return loadIncidentThreadMessages(db, asString(asObject(payload).threadId))
    },
    'incidents:saveThread': async (payload: unknown) => {
      return store.saveThread(asObject(payload).thread)
    },
    'incidents:appendThreadMessages': async (payload: unknown) => {
      const { threadId, messages } = asObject(payload)
      await appendIncidentThreadMessages(db, asString(threadId), Array.isArray(messages) ? messages : [])
      return { ok: true }
    },
    'desktopState:bootstrap': async (payload: unknown) => {
      return store.bootstrap(asObject(payload))
    },
    'desktopState:syncRunbooks': async (payload: unknown) => {
      return store.syncRunbooks(asObject(payload))
    },
    'desktopState:syncResults': async (payload: unknown) => {
      return store.syncResults(asObject(payload))
    },
  }
}
