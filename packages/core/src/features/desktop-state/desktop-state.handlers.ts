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

export interface DesktopStateDatabase {
  legacyImportLedger: DesktopStateFindUniqueTable & DesktopStateUpsertTable
  incidentMessage: DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable
  incidentThread:
    & DesktopStateCountTable
    & DesktopStateDeleteManyTable
    & DesktopStateCreateTable
    & DesktopStateFindManyTable
  runbook:
    & DesktopStateCountTable
    & DesktopStateDeleteManyTable
    & DesktopStateCreateTable
    & DesktopStateFindManyTable
  runbookAction: DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable
  runbookVersion: DesktopStateDeleteManyTable
  investigationSession:
    & DesktopStateCountTable
    & DesktopStateDeleteManyTable
    & DesktopStateCreateTable
    & DesktopStateFindManyTable
  investigationTraceEntry: DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable
  investigationToolRun: DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable
  investigationReport: DesktopStateDeleteManyTable & DesktopStateCreateTable & DesktopStateFindManyTable
  $queryRawUnsafe<T extends DesktopStateRow = DesktopStateRow>(query: string): Promise<T[]>
  $executeRawUnsafe(query: string): Promise<unknown>
}

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

type ChatMessage =
  | { kind: 'user'; text: string }
  | {
      kind: 'agent'
      streamText: string
      toolCalls: ToolCallRecord[]
      finalText: string | null
      status: 'thinking' | 'streaming' | 'done' | 'error' | 'cancelled'
      errorMsg?: string
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
  incidents: IncidentThreadRecord[]
  incidentMessages: Record<string, ChatMessage[]>
  runbooks: RunbookRecord[]
  results: StoredRunResult[]
  resultTraces: Record<string, ResultTraceMemory>
}

interface DesktopStatePayload extends Partial<DesktopProductStateSnapshot> {
  investigations?: unknown[]
  investigationTraces?: Record<string, unknown>
}
interface DesktopIncidentStateSnapshot {
  incidents: IncidentThreadRecord[]
  incidentMessages: Record<string, ChatMessage[]>
}

const PHASE1_IMPORT_KEY = 'phase1.localstorage.bootstrap'

function isDuplicateColumnError(error: unknown): boolean {
  return error instanceof Error && /duplicate column name/i.test(error.message)
}

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

function normalizeIncident(raw: unknown): IncidentThreadRecord | null {
  const value = asObject(raw)
  const id = asString(value.id)
  if (id.length === 0) return null

  const archivedAt = asNullableIsoString(value.archivedAt)
  const archived = value.archived === true || archivedAt != null
  let normalizedArchivedAt: string | undefined
  if (archived) {
    normalizedArchivedAt = archivedAt ?? new Date().toISOString()
  }

  return {
    id,
    title: asString(value.title, 'New Incident'),
    createdAt: asIsoString(value.createdAt),
    prompt: asString(value.prompt),
    state: asString(value.state, 'IDLE'),
    sessionId: asOptionalNonEmptyString(value.sessionId),
    archived,
    archivedAt: normalizedArchivedAt,
    lastMessagePreview: normalizePreviewText(asOptionalString(value.lastMessagePreview)),
  }
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

function normalizeChatMessage(raw: unknown): ChatMessage | null {
  const value = asObject(raw)
  const kind = asString(value.kind)
  if (kind === 'user') {
    return {
      kind: 'user',
      text: asString(value.text),
    }
  }

  if (kind === 'agent') {
    const fallbackText = latestIterationText(value)
    const toolCalls = dedupeToolCalls(value.toolCalls)

    return {
      kind: 'agent',
      streamText: asString(value.streamText, fallbackText),
      toolCalls,
      finalText: normalizeAgentFinalText(value, fallbackText),
      status: asString(value.status, 'thinking') as Exclude<ChatMessage, { kind: 'user' }>['status'],
      errorMsg: asOptionalString(value.errorMsg),
    }
  }

  return null
}

function normalizeIncidentMessages(
  value: unknown,
): Record<string, ChatMessage[]> {
  const input = asObject(value)
  const output: Record<string, ChatMessage[]> = {}
  for (const [key, messages] of Object.entries(input)) {
    if (!Array.isArray(messages)) continue
    output[key] = messages
      .map((message) => normalizeChatMessage(message))
      .filter((message): message is ChatMessage => message !== null)
  }
  return output
}

function normalizePreviewText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length > 0) {
    return normalized
  }

  return null
}

function getIncidentPreviewFromMessages(messages: ChatMessage[]): string | null {
  let lastMessage: ChatMessage | undefined
  if (messages.length > 0) {
    lastMessage = messages[messages.length - 1]
  }
  if (lastMessage === undefined) return null
  if (lastMessage.kind === 'user') {
    return normalizePreviewText(lastMessage.text)
  }

  return normalizePreviewText(lastMessage.finalText ?? lastMessage.streamText)
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

function normalizeIncidentsList(value: unknown): IncidentThreadRecord[] {
  if (!Array.isArray(value)) return []

  const incidents: IncidentThreadRecord[] = []
  for (const item of value) {
    const incident = normalizeIncident(item)
    if (incident !== null) {
      incidents.push(incident)
    }
  }

  return incidents
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
  incidents: IncidentThreadRecord[],
  runbooks: RunbookRecord[],
  results: StoredRunResult[],
  incidentMessages: Record<string, ChatMessage[]>,
  resultTraces: Record<string, ResultTraceMemory>,
): boolean {
  return (
    incidents.length > 0 ||
    runbooks.length > 0 ||
    results.length > 0 ||
    Object.keys(incidentMessages).length > 0 ||
    Object.keys(resultTraces).length > 0
  )
}

function hasIncidentPayload(
  incidents: IncidentThreadRecord[],
  incidentMessages: Record<string, ChatMessage[]>,
): boolean {
  return incidents.length > 0 || Object.keys(incidentMessages).length > 0
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

function normalizeIncidentMessageRow(rawMessage: unknown): ChatMessage {
  const message = asObject(rawMessage)
  if (asString(message.kind) === 'user') {
    return {
      kind: 'user',
      text: asString(message.text),
    }
  }

  return {
    kind: 'agent',
    streamText: asString(message.streamText),
    toolCalls: dedupeToolCalls(safeJsonParse(message.toolCallsJson, [])),
    finalText: nullableString(message.finalText),
    status: asString(message.status, 'thinking') as Exclude<ChatMessage, { kind: 'user' }>['status'],
    errorMsg: asOptionalString(message.errorMsg),
  }
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return asString(value)
}

function addIncidentMessage(
  incidentMessages: Record<string, ChatMessage[]>,
  rawMessage: unknown,
): void {
  const message = asObject(rawMessage)
  const threadId = asString(message.threadId)
  if (threadId.length === 0) return
  if (!Object.prototype.hasOwnProperty.call(incidentMessages, threadId)) {
    incidentMessages[threadId] = []
  }

  incidentMessages[threadId].push(normalizeIncidentMessageRow(message))
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

function normalizeIncidentRow(
  rawIncident: unknown,
  incidentMessages: Record<string, ChatMessage[]>,
): IncidentThreadRecord {
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
    lastMessagePreview: getIncidentPreviewFromMessages(incidentMessages[id] ?? []) ?? normalizePreviewText(prompt),
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
  private incidentSessionIdColumnEnsured = false

  constructor(private readonly db: DesktopStateDatabase) {}

  async bootstrap(payload: DesktopStatePayload): Promise<DesktopProductStateSnapshot> {
    const incidents = normalizeIncidentsList(payload.incidents)
    const runbooks = normalizeRunbooksList(payload.runbooks)
    const results = normalizeResultsList(payloadResults(payload))
    const incidentMessages = normalizeIncidentMessages(payload.incidentMessages)
    const resultTraces = normalizeResultTraces(payloadResultTraces(payload))

    const importLedger = await this.db.legacyImportLedger.findUnique({
      where: { key: PHASE1_IMPORT_KEY },
    })

    if (importLedger === null) {
      await this.bootstrapFirstImport(incidents, runbooks, results, incidentMessages, resultTraces)
    } else {
      await this.bootstrapExistingState(incidents, runbooks, results, incidentMessages, resultTraces)
    }

    return this.readSnapshot()
  }

  private async bootstrapFirstImport(
    incidents: IncidentThreadRecord[],
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
    incidentMessages: Record<string, ChatMessage[]>,
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    if (hasImportPayload(incidents, runbooks, results, incidentMessages, resultTraces)) {
      await this.replaceIncidents(incidents, incidentMessages)
      await this.replaceRunbooks(runbooks)
      const existingInvestigationCount = await this.db.investigationSession.count({})
      if (existingInvestigationCount === 0 && hasResultPayload(results, resultTraces)) {
        await this.replaceResults(results, resultTraces)
      }
    }

    await this.recordLegacyImport(incidents, runbooks, results)
  }

  private async bootstrapExistingState(
    incidents: IncidentThreadRecord[],
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
    incidentMessages: Record<string, ChatMessage[]>,
    resultTraces: Record<string, ResultTraceMemory>,
  ): Promise<void> {
    const [existingIncidentCount, existingRunbookCount, existingInvestigationCount] =
      await Promise.all([
        this.db.incidentThread.count({}),
        this.db.runbook.count({}),
        this.db.investigationSession.count({}),
      ])

    if (existingIncidentCount === 0 && hasIncidentPayload(incidents, incidentMessages)) {
      await this.replaceIncidents(incidents, incidentMessages)
    }

    if (existingRunbookCount === 0 && runbooks.length > 0) {
      await this.replaceRunbooks(runbooks)
    }

    if (existingInvestigationCount === 0 && hasResultPayload(results, resultTraces)) {
      await this.replaceResults(results, resultTraces)
    }
  }

  private async recordLegacyImport(
    incidents: IncidentThreadRecord[],
    runbooks: RunbookRecord[],
    results: StoredRunResult[],
  ): Promise<void> {
    const payloadJson = JSON.stringify({
      incidents: incidents.length,
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

  async syncIncidents(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    const incidents = normalizeIncidentsList(payload.incidents)
    const incidentMessages = normalizeIncidentMessages(payload.incidentMessages)
    await this.replaceIncidents(incidents, incidentMessages)
    return { ok: true, count: incidents.length }
  }

  async getIncidentState(): Promise<DesktopIncidentStateSnapshot> {
    const snapshot = await this.readSnapshot()
    return {
      incidents: snapshot.incidents,
      incidentMessages: snapshot.incidentMessages,
    }
  }

  async replaceIncidentState(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    return this.syncIncidents(payload)
  }

  async syncRunbooks(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    const runbooks = normalizeRunbooksList(payload.runbooks)
    await this.replaceRunbooks(runbooks)
    return { ok: true, count: runbooks.length }
  }

  async syncResults(payload: DesktopStatePayload): Promise<{ ok: true; count: number }> {
    const results = normalizeResultsList(payloadResults(payload))
    const resultTraces = normalizeResultTraces(payloadResultTraces(payload))
    await this.replaceResults(results, resultTraces)
    return { ok: true, count: results.length }
  }

  private async replaceIncidents(
    incidents: IncidentThreadRecord[],
    incidentMessages: Record<string, ChatMessage[]>,
  ): Promise<void> {
    await this.ensureIncidentThreadSessionIdColumn()
    await this.db.incidentMessage.deleteMany({})
    await this.db.incidentThread.deleteMany({})

    for (const incident of incidents) {
      await this.db.incidentThread.create({
        data: {
          id: incident.id,
          title: incident.title,
          prompt: incident.prompt,
          state: incident.state,
          sessionId: incident.sessionId ?? null,
          createdAt: incident.createdAt,
          updatedAt: incident.createdAt,
          archivedAt: incident.archivedAt ?? null,
        },
      })

      const messages = incidentMessages[incident.id] ?? []
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]
        if (message.kind === 'user') {
          await this.db.incidentMessage.create({
            data: {
              id: `${incident.id}:user:${String(index)}`,
              threadId: incident.id,
              sortOrder: index,
              kind: 'user',
              text: message.text,
              createdAt: incident.createdAt,
              updatedAt: incident.createdAt,
            },
          })
          continue
        }

        await this.db.incidentMessage.create({
          data: {
            id: `${incident.id}:agent:${String(index)}`,
            threadId: incident.id,
            sortOrder: index,
            kind: 'agent',
            streamText: message.streamText,
            toolCallsJson: JSON.stringify(message.toolCalls),
            finalText: message.finalText,
            status: message.status,
            errorMsg: message.errorMsg,
            createdAt: incident.createdAt,
            updatedAt: incident.createdAt,
          },
        })
      }
    }
  }

  private async replaceRunbooks(runbooks: RunbookRecord[]): Promise<void> {
    await this.db.runbookAction.deleteMany({})
    await this.db.runbookVersion.deleteMany({})
    await this.db.runbook.deleteMany({})

    for (const runbook of runbooks) {
      await this.replaceRunbook(runbook)
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
      url = action.pluginAuth
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
    await this.db.investigationToolRun.deleteMany({})
    await this.db.investigationTraceEntry.deleteMany({})
    await this.db.investigationReport.deleteMany({})
    await this.db.investigationSession.deleteMany({})

    for (const result of results) {
      const trace = resultTraces[result.id] ?? emptyTrace()
      await this.replaceResult(result, trace)
    }
  }

  private async replaceResult(result: StoredRunResult, trace: ResultTraceMemory): Promise<void> {
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
    await this.ensureIncidentThreadSessionIdColumn()
    const [incidents, messages, runbooks, runbookActions, resultRows, traceEntries, toolRuns, reports] =
      await Promise.all([
        this.db.incidentThread.findMany({ orderBy: { createdAt: 'desc' } }),
        this.db.incidentMessage.findMany({ orderBy: { sortOrder: 'asc' } }),
        this.db.runbook.findMany({ orderBy: { createdAt: 'desc' } }),
        this.db.runbookAction.findMany({ orderBy: { sortOrder: 'asc' } }),
        this.db.investigationSession.findMany({ orderBy: { startedAt: 'desc' } }),
        this.db.investigationTraceEntry.findMany({}),
        this.db.investigationToolRun.findMany({ orderBy: { sortOrder: 'asc' } }),
        this.db.investigationReport.findMany({}),
      ])

    const incidentMessages: Record<string, ChatMessage[]> = {}
    for (const rawMessage of messages) {
      addIncidentMessage(incidentMessages, rawMessage)
    }

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

    const normalizedIncidents = incidents.map((incident) => normalizeIncidentRow(incident, incidentMessages))

    return {
      incidents: normalizedIncidents,
      incidentMessages,
      runbooks: runbooks.map((runbook) => normalizeRunbookRow(runbook, runbookActionsByRunbookId)),
      results: resultRows.map((result) => normalizeResultRow(result)),
      resultTraces: normalizeResultTraceEntries(resultRows, resultTraces),
    }
  }

  private async ensureIncidentThreadSessionIdColumn(): Promise<void> {
    if (this.incidentSessionIdColumnEnsured) return

    const rows = await this.db.$queryRawUnsafe<{ name?: unknown }>(
      'PRAGMA table_info("IncidentThread")',
    )
    const hasSessionIdColumn = rows.some(
      (row) => asString(row.name).trim() === 'sessionId',
    )

    if (!hasSessionIdColumn) {
      try {
        await this.db.$executeRawUnsafe(`
          ALTER TABLE "IncidentThread" ADD COLUMN "sessionId" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error
        }
      }
    }

    this.incidentSessionIdColumnEnsured = true
  }
}

export function createDesktopStateHandlers(
  db: DesktopStateDatabase,
): Record<string, RpcHandler> {
  const store = new DesktopStateStore(db)

  return {
    'incidents:getState': async () => {
      return store.getIncidentState()
    },
    'incidents:replaceState': async (payload: unknown) => {
      return store.replaceIncidentState(asObject(payload))
    },
    'desktopState:bootstrap': async (payload: unknown) => {
      return store.bootstrap(asObject(payload))
    },
    'desktopState:syncIncidents': async (payload: unknown) => {
      return store.syncIncidents(asObject(payload))
    },
    'desktopState:syncRunbooks': async (payload: unknown) => {
      return store.syncRunbooks(asObject(payload))
    },
    'desktopState:syncResults': async (payload: unknown) => {
      return store.syncResults(asObject(payload))
    },
  }
}
