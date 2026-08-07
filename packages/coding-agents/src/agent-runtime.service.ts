/**
 * Agent Runtime Service
 *
 * Main-process agentic tool execution loop.
 * Manages sessions, tool execution, and event streaming to renderer.
 *
 * Guardrails:
 * - All tool execution in main process only
 * - No SSH key/passphrase storage
 * - System SSH identity only
 */

import { codingAgentsLogger as log } from './logger.js'
import { createHash, randomUUID } from 'crypto'
import { zodToJsonSchema } from '@alcyone-labs/zod-to-json-schema'
import { z } from 'zod'
import { getErrorMessage } from '@bitsentry-ce/core'
import type { AgentThreadSnapshot } from '@bitsentry-ce/components/chat/types'
import {
  appendPromptToThreadSnapshot,
  createAgentThreadSnapshot,
  reduceAgentThreadSnapshot,
  setAgentThreadRuntimeState,
} from '@bitsentry-ce/components/chat/runtimeProjection'
import {
  validateToolInput,
  getTool,
  getAllToolDefinitions,
} from '@bitsentry-ce/core/features/agent-runtime/shared/capability-registry'
import {
  runOrchestratedOperation,
} from '@bitsentry-ce/core/features/agent-runtime/shared/effect-orchestration'
import type {
  AgentChatAttachment,
  AgentErrorCode,
  AgentEventData,
  AgentLlmSelection,
  AgentSendInput,
  AgentSessionState,
  AgentSessionStatus,
  AgentStartInput,
  AgentProviderKey,
  ToolContext,
  ToolResult,
  RunbookContext,
  RunbookAction,
} from '@bitsentry-ce/core/features/agent-runtime/types'
import type {
  AgentLlmAdapterService,
  ChatMessage,
  ToolCall,
} from './agent-llm-adapter.service.js'
import type {
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
  RunbookParameterValues,
  RunbookRecord,
  RunbookTriggerContext,
} from '@bitsentry-ce/core/features/runbooks/desktop-runbook.types'
import type { RunbookGateway } from '@bitsentry-ce/core/features/runbooks'
import type { DesktopPluginRuntimeService } from '@bitsentry-ce/core/features/plugins'
import { approveRunbookAuthoringProposal, getRunbookAuthoringRevisionHash, rejectRunbookAuthoringProposal, requestRunbookAuthoringRevision, type RunbookAuthoringProposal } from '@bitsentry-ce/core/features/runbooks/authoring'
import {
  createAgentToolResultEnvelope,
  executeHostTool,
  getHostTools,
  isHostToolName,
  type AgentSessionRef,
  type ExecuteRunbookHostToolInput,
  type HostToolContext,
  type HostToolEvent,
} from '@bitsentry-ce/core/features/agent-runtime'

const CHANNEL_EVENT = 'bitsentry:agent:event'
const NO_LLM_PROVIDER_CONFIGURED_MESSAGE =
  'No LLM provider configured. Please configure a provider in Settings.'

export interface AgentRuntimeEventPayload {
  sessionId: string
  event: AgentEventData
  snapshot?: AgentThreadSnapshot
}

export interface AgentRuntimeWindow {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, payload: AgentRuntimeEventPayload): void
  }
}

export type AgentRuntimeLlmAdapter = Pick<AgentLlmAdapterService, 'chatWithTools'>
export type AgentRuntimeRunbookGateway = RunbookGateway
export interface AgentRuntimeRunbookStore { list(): Promise<RunbookRecord[]>; create(payload: Record<string, unknown>): Promise<RunbookRecord>; getIncludingDeleted(id: string): Promise<{ runbook: RunbookRecord; deletedAt: string | null } | null>; updateMeta(payload: Record<string, unknown>): Promise<RunbookRecord | null>; updateActions(payload: Record<string, unknown>): Promise<RunbookRecord | null>; remove(payload: Record<string, unknown>): Promise<unknown>; purge(payload: Record<string, unknown>): Promise<unknown> }
export interface RunbookAuthoringProposalReview { status: RunbookAuthoringProposal['status']; approvalRequired: true; saved: boolean; proposalId: string; kind: RunbookAuthoringProposal['kind']; incidentThreadId?: string; targetRunbookId?: string; targetRevisionNumber?: number; proposedRunbook: { id: string; title: string; description: string; revisionNumber: number; actionCount: number; actions: Array<{ id: string; type: string; title: string }> }; validation: RunbookAuthoringProposal['validation']; operationDiffs: RunbookAuthoringProposal['operationDiffs']; nextStep: string }
export interface RunbookAuthoringProposalDecisionResult { proposal: RunbookAuthoringProposalReview; savedRunbook?: RunbookRecord; approvedOperationIds?: string[]; reason?: string; requestedEdit?: string }

export interface AgentRuntimeDebugHooks {
  isLocalCodingAgentDeltaStreamingEnabled(): boolean
  recordCodingAgentDebugEvent(
    stage: string,
    data: Record<string, unknown>,
  ): void
  recordCodingAgentDebugAnomaly(
    stage: string,
    data: Record<string, unknown>,
  ): void
}

const DEFAULT_AGENT_RUNTIME_DEBUG_HOOKS: AgentRuntimeDebugHooks = {
  isLocalCodingAgentDeltaStreamingEnabled() {
    return false
  },
  recordCodingAgentDebugEvent() {},
  recordCodingAgentDebugAnomaly() {},
}

function remapRunbookAuthoringPersistenceIds(runbook: RunbookRecord): RunbookRecord {
  return {
    ...runbook,
    actions: runbook.actions.map((action) => ({
      ...action,
      id: randomUUID(),
      parameters: action.parameters?.map((parameter) => ({
        ...parameter,
        id: randomUUID(),
      })),
    })),
  }
}

function stableRunbookPersistenceValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableRunbookPersistenceValue).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableRunbookPersistenceValue(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function comparableRunbookPersistenceAction(action: RunbookRecord['actions'][number]): Record<string, unknown> {
  const actionWithoutId = Object.fromEntries(
    Object.entries(action).filter(([key]) => key !== 'id'),
  ) as Omit<typeof action, 'id'>
  const { parameters, ...fields } = actionWithoutId
  return {
    ...fields,
    parameters: parameters?.map(({ id: _parameterId, ...parameter }) => ({
      ...parameter,
      label: parameter.label ?? parameter.key,
    })),
  }
}

function hasCompleteAuthoringPersistence(
  expected: RunbookRecord,
  saved: RunbookRecord,
): boolean {
  return saved.title === expected.title &&
    saved.description === expected.description &&
    saved.idleTimeout === expected.idleTimeout &&
    saved.actions.length === expected.actions.length &&
    saved.actions.every((action, index) =>
      stableRunbookPersistenceValue(comparableRunbookPersistenceAction(action)) ===
        stableRunbookPersistenceValue(comparableRunbookPersistenceAction(expected.actions[index])),
    )
}

function getAgentErrorCode(message: string): AgentErrorCode | undefined {
  if (message === NO_LLM_PROVIDER_CONFIGURED_MESSAGE) {
    return 'NO_LLM_PROVIDER_CONFIGURED'
  }

  return undefined
}

const DEFAULT_AGENT_SESSION_TIMEOUT_MS = 300_000
const MAX_TOOL_ITERATIONS = 10 // Prevent infinite loops
const MAX_MESSAGE_HISTORY = 50 // Limit conversation history
const JOURNAL_TIME_WINDOW_PADDING_MS = 5 * 60 * 1000
const MAX_ACTIONABLE_JOURNAL_TIME_WINDOWS = 5
const MAX_STRUCTURED_RUNBOOK_ISSUES = 10
const MAX_DERIVED_JOURNAL_TIME_WINDOW_SPAN_MS = 24 * 60 * 60 * 1000
const INCIDENT_TIMESTAMP_PATTERN =
  /\b\d{4}-\d\d-\d\d[Tt ]\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?(?:Z| UTC|[+-]\d\d:?\d\d)?\b/g

const unknownRecordSchema = z.record(z.string(), z.unknown())

function readUnknownRecord(value: unknown): Record<string, unknown> | null {
  const parsed = unknownRecordSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }

  return parsed.data
}

function parseKeyValueToolInput(input: string): Record<string, unknown> | null {
  const parsed: Record<string, unknown> = {}

  for (const line of input.trim().split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) {
      continue
    }

    const key = line.slice(0, colonIndex).trim()
    if (key.length === 0) {
      continue
    }

    parsed[key] = line.slice(colonIndex + 1).trim()
  }

  if (Object.keys(parsed).length === 0) {
    return null
  }

  return parsed
}

function parseWrappedToolInput(args: Record<string, unknown>): Record<string, unknown> | null {
  const inputField = args.input
  if (typeof inputField !== 'string') {
    return null
  }

  try {
    return readUnknownRecord(JSON.parse(inputField) as unknown)
  } catch {
    return parseKeyValueToolInput(inputField)
  }
}

function normalizeRunbookParameterRecord(value: unknown): Record<string, string> | undefined {
  const record = readUnknownRecord(value)
  if (record === null) {
    return undefined
  }

  const entries = Object.entries(record).flatMap(([key, rawValue]) => {
    const normalizedKey = key.trim()
    if (normalizedKey.length === 0 || rawValue == null) {
      return []
    }

    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      return []
    }

    return [[normalizedKey, String(rawValue)] as const]
  })

  if (entries.length === 0) {
    return undefined
  }

  return Object.fromEntries(entries)
}

function normalizeExecuteRunbookArgs(args: Record<string, unknown>): Record<string, unknown> {
  const wrappedInput = parseWrappedToolInput(args)
  const mergedArgs = { ...args }
  if (wrappedInput !== null) {
    Object.assign(mergedArgs, wrappedInput)
  }
  delete mergedArgs.input

  const reservedKeys = new Set(['runbookId', 'runbookTitle', 'parameterValues', 'parameters'])
  const explicitParameterValues =
    normalizeRunbookParameterRecord(mergedArgs.parameterValues) ??
    normalizeRunbookParameterRecord(mergedArgs.parameters)
  const topLevelParameterValues = Object.fromEntries(
    Object.entries(mergedArgs).flatMap(([key, rawValue]) => {
      if (reservedKeys.has(key) || rawValue == null) {
        return []
      }

      if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
        return []
      }

      return [[key, String(rawValue)] as const]
    }),
  )
  const parameterValues = {
    ...topLevelParameterValues,
    ...(explicitParameterValues ?? {}),
  }
  const normalized: Record<string, unknown> = {}
  if (Object.keys(parameterValues).length > 0) {
    normalized.parameterValues = parameterValues
  }
  if ('runbookId' in mergedArgs) {
    normalized.runbookId = mergedArgs.runbookId
  }
  if ('runbookTitle' in mergedArgs) {
    normalized.runbookTitle = mergedArgs.runbookTitle
  }

  return normalized
}

function normalizeGetRunbookExecutionArgs(args: Record<string, unknown>): Record<string, unknown> {
  const wrappedInput = parseWrappedToolInput(args)
  const mergedArgs = { ...args }
  if (wrappedInput !== null) {
    Object.assign(mergedArgs, wrappedInput)
  }
  delete mergedArgs.input

  const normalized: Record<string, unknown> = {}
  if ('executionId' in mergedArgs) {
    normalized.executionId = mergedArgs.executionId
  }
  if ('waitForCompletion' in mergedArgs) {
    normalized.waitForCompletion = mergedArgs.waitForCompletion
  }
  return normalized
}

const sshJournalStringFields = new Set<string>(['host', 'username', 'since', 'until', 'cursor', 'sourceId'])
const sshJournalNumberFields = new Set<string>(['port', 'limit'])
const sshJournalArrayFields = new Set<string>(['units', 'priorities'])
const sshJournalBooleanFields = new Set<string>(['follow'])
const sshJournalFields = new Set<string>([
  ...sshJournalStringFields,
  ...sshJournalNumberFields,
  ...sshJournalArrayFields,
  ...sshJournalBooleanFields,
])

function normalizeSshJournalNumberValue(rawValue: unknown): number | undefined {
  let parsed: number
  if (typeof rawValue === 'number') {
    parsed = rawValue
  } else {
    parsed = Number(String(rawValue))
  }

  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined
  }

  return parsed
}

function normalizeSshJournalBooleanValue(rawValue: unknown): boolean | undefined {
  if (rawValue === true || rawValue === 'true') {
    return true
  }

  if (rawValue === false || rawValue === 'false') {
    return false
  }

  return undefined
}

function normalizeSshJournalArrayValue(rawValue: unknown): string[] | undefined {
  if (Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value))
  }

  if (typeof rawValue !== 'string') {
    return undefined
  }

  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (values.length === 0) {
    return undefined
  }

  return values
}

function normalizeSshJournalValue(key: string, rawValue: unknown): unknown {
  if (sshJournalStringFields.has(key)) {
    return String(rawValue)
  }

  if (sshJournalNumberFields.has(key)) {
    return normalizeSshJournalNumberValue(rawValue)
  }

  if (sshJournalBooleanFields.has(key)) {
    return normalizeSshJournalBooleanValue(rawValue)
  }

  if (sshJournalArrayFields.has(key)) {
    return normalizeSshJournalArrayValue(rawValue)
  }

  return undefined
}

/**
 * Normalize tool arguments before validation.
 *
 * Some LLMs (especially via OpenRouter) wrap tool params in an `input` string
 * instead of using top-level fields. This normalizes those cases.
 *
 * Handles two wrapped formats:
 * 1. JSON string: '{"host": "...", "username": "...", ...}'
 * 2. Multiline key:value: 'host: ...\nusername: ...\nsince: ...'
 *
 * Only applies to tools that are known to receive wrapped or loosely-shaped args.
 */

function normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === 'execute_runbook') {
    return normalizeExecuteRunbookArgs(args)
  }

  if (toolName === 'get_runbook_execution') {
    return normalizeGetRunbookExecutionArgs(args)
  }

  if (toolName !== 'ssh_journal_query') {
    return args
  }

  const parsed = parseWrappedToolInput(args)
  if (parsed === null) {
    return args
  }

  const normalized: Record<string, unknown> = { ...args }

  for (const [key, rawValue] of Object.entries(parsed)) {
    if (!sshJournalFields.has(key)) continue

    const value = normalizeSshJournalValue(key, rawValue)
    if (value !== undefined) {
      normalized[key] = value
    }
  }

  // Remove the problematic 'input' field
  delete normalized.input

  // Validate required fields are present
  const requiredFields = ['host', 'username', 'since'] as const
  for (const field of requiredFields) {
    if (normalized[field] === undefined) {
      throw new Error(`Tool args malformed: missing required field '${field}'`)
    }
  }

  return normalized
}

/**
 * In-memory session state (no persisted secrets).
 */
interface AgentSession {
  id: string
  state: AgentSessionState
  startedAt: Date
  expiresAt: number
  abortController: AbortController
  timeoutHandle: ReturnType<typeof setTimeout> | null
  currentToolCallId: string | null
  currentTurnId?: string
  windowGetter: () => AgentRuntimeWindow | null
  llmAdapter: AgentRuntimeLlmAdapter
  messages: ChatMessage[] // Conversation history
  runbookContext?: RunbookContext
  llmSelection?: AgentLlmSelection
  accessLevel?: 'auto-accept-edits' | 'full-access'
  traitValues?: Record<string, string | boolean>
  incidentThreadId?: string
  latestRunbookExecutionId?: string
  latestRunbookResultId?: string
  latestRunbookTitle?: string
  latestJournalTimeWindowParameters?: RunbookParameterValues
  currentTurnRunbookExecutionLookups?: Set<string>
  currentTurnStartedRunbookExecutionIds?: Set<string>
  currentTurnHostToolCalls?: Map<string, ObservedHostToolCall>
  currentTurnVisibleRunbookExecutionIds?: Set<string>
  runbookAuthoringProposals: RunbookAuthoringProposal[]
  hasRunbookParameters?: boolean
  hasMultipleRunbooksInPlay?: boolean
  queuedFollowUps: AgentSendInput[]
  loopActive?: boolean
  snapshot: AgentThreadSnapshot
}

type ExecuteRunbookInput = ExecuteRunbookHostToolInput

type CompletedToolResult = {
  toolCall: ToolCall
  result: ToolResult
  modelContext: string
}

type ObservedHostToolCall = {
  toolCall: ToolCall
  result?: ToolResult
  modelContext?: string
}

type DirectRunbookExecutionResult = {
  toolCall: ToolCall
  result: ToolResult
  modelContext: string
  visibleResult: VisibleRunbookToolResult | null
}

type VisibleRunbookToolResult = {
  text: string
  executionId?: string
  dedupeText?: string
  dedupeTokens?: string[]
}

type VisibleRunbookExecutionData = {
  runbookTitle: string
  status: string
  executionId: string
  latestStep: Record<string, unknown> | null
  finalOutput: string | null
  finalOutputTruncated: boolean
  finalOutputLength: number | null
  latestStepError: string | null
  windowCount: number
  completedStepCount: number | null
  stepCount: number | null
}

type TurnTokenUsage = {
  inputTokens: number
  outputTokens: number
  contextTokens?: number
  contextLimit?: number
}

type LocalCodingAgentProviderKey = Extract<AgentProviderKey, 'claude_code' | 'codex' | 'opencode' | 'cursor'>

function getLocalCodingAgentProviderKey(selection: AgentLlmSelection | undefined): LocalCodingAgentProviderKey | null {
  const providerKey = selection?.providerKey
  if (
    providerKey === 'codex' ||
    providerKey === 'claude_code' ||
    providerKey === 'opencode' ||
    providerKey === 'cursor'
  ) {
    return providerKey
  }

  return null
}

function joinNonEmptyBlocks(...blocks: string[]): string {
  return blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join('\n\n')
}

function mergeTurnTokenUsage(current: TurnTokenUsage | undefined, usage: TurnTokenUsage): TurnTokenUsage {
  if (current === undefined) {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      contextTokens: usage.contextTokens,
      contextLimit: usage.contextLimit,
    }
  }

  return {
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    contextTokens: usage.contextTokens ?? current.contextTokens,
    contextLimit: usage.contextLimit ?? current.contextLimit,
  }
}

function getToolEndState(result: ToolResult): 'COMPLETED' | 'FAILED' {
  if (result.error !== undefined && result.error.length > 0) {
    return 'FAILED'
  }

  return 'COMPLETED'
}

function truncateToolChunk(chunk: string): string {
  if (chunk.length <= 1000) {
    return chunk
  }

  return `${chunk.slice(0, 1000)}...[truncated]`
}

function isAbortSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function formatRunbookActionParameterPromptLine(parameter: NonNullable<RunbookAction['parameters']>[number]): string {
  let line = `   Parameter ${parameter.key}: `
  if (parameter.description !== undefined && parameter.description.length > 0) {
    line += parameter.description
  } else {
    line += 'No description'
  }

  if (parameter.defaultValue !== undefined && parameter.defaultValue.length > 0) {
    line += ` (default: ${parameter.defaultValue})`
  }

  return line
}

function appendRunbookHttpActionPromptLines(actionDetails: string[], action: RunbookAction): void {
  if (action.url === undefined || action.url.length === 0) {
    return
  }

  let method = 'GET'
  if (action.method !== undefined) {
    method = action.method
  }

  actionDetails.push(`   ${method} ${action.url}`)
  if (action.body !== undefined && action.body.length > 0) {
    actionDetails.push(`   Body: ${action.body}`)
  }
}

function appendRunbookActionPromptLines(actionDetails: string[], action: RunbookAction): void {
  if (action.type === 'shell' && action.command !== undefined && action.command.length > 0) {
    actionDetails.push(`   Command: ${action.command}`)
    return
  }

  if (action.type === 'llm' && action.prompt !== undefined && action.prompt.length > 0) {
    actionDetails.push(`   Prompt: ${action.prompt}`)
    return
  }

  if (action.type === 'http') {
    appendRunbookHttpActionPromptLines(actionDetails, action)
    return
  }

  if (action.type === 'external_source' && action.query !== undefined && action.query.length > 0) {
    actionDetails.push(`   Query: ${action.query}`)
  }
}

function formatRunbookActionPromptBlock(action: RunbookAction, index: number): string {
  const actionDetails: string[] = [`${String(index + 1)}. [${action.type}] ${action.title}`]
  appendRunbookActionPromptLines(actionDetails, action)

  if (action.parameters !== undefined && action.parameters.length > 0) {
    actionDetails.push(...action.parameters.map(formatRunbookActionParameterPromptLine))
  }

  return actionDetails.join('\n')
}

function appendRunbookToolPromptLines(lines: string[], runbookId: string, hasRunbookTools: boolean): void {
  if (!hasRunbookTools) {
    return
  }

  lines.push(
    `To actually run this runbook through the runbook engine, call execute_runbook with runbookId "${runbookId}". Include parameterValues when the user gave values that should override defaults.`,
    'Do not manually imitate a full runbook execution with direct tools when the user asked to run the runbook.',
  )
}

function createUserMessageContent(text: string, attachments?: AgentChatAttachment[]): ChatMessage['content'] {
  const normalizedText = text.trim()
  const normalizedAttachments = attachments ?? []

  if (normalizedAttachments.length === 0) {
    return normalizedText
  }

  return [
    { type: 'text', text: normalizedText },
    ...normalizedAttachments.map((attachment) => ({
      type: 'image' as const,
      image: {
        type: 'image' as const,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: attachment.dataUrl,
      },
    })),
  ]
}

function readChatMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content
  }

  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function normalizeRunbookMention(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function hasRunbookExecutionBlocker(rawText: string, normalizedText: string): boolean {
  const lowerText = rawText.toLowerCase()
  if (/\b(don't|dont|do not|never|not)\b/.test(lowerText)) {
    return true
  }

  if (/\b(should|would)\s+(we|i|you)\s+(run|start|execute|trigger|launch)\b/.test(normalizedText)) {
    return true
  }

  return false
}

function hasExplicitRunbookExecutionIntent(rawText: string, normalizedText: string): boolean {
  if (hasRunbookExecutionBlocker(rawText, normalizedText)) {
    return false
  }

  return /\b(run|start|execute|trigger|launch)\b/.test(normalizedText)
}

function asksForNamedRunbookOutput(
  rawText: string,
  normalizedText: string,
  normalizedRunbookTitle: string,
): boolean {
  if (normalizedRunbookTitle.length === 0 || hasRunbookExecutionBlocker(rawText, normalizedText)) {
    return false
  }

  if (!normalizedText.includes(normalizedRunbookTitle)) {
    return false
  }

  const resultRequestPattern =
    /\b(what|summarize|summary|result|results|output|said|says|showed|shows|found|finds|reported|reports|returned|returns|figure out|inspect|check)\b/
  return resultRequestPattern.test(normalizedText)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripDirectParameterQuotes(value: string): string {
  return value.replace(/^["'`]|["'`]$/g, '').trim()
}

function readDirectParameterValue(rawText: string, key: string): string | undefined {
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9_-])${escapeRegExp(key)}(?=$|[^A-Za-z0-9_-])\\s*(?:=|:|is\\b|to\\b|as\\b)?\\s*("[^"]+"|'[^']+'|\`[^\`]+\`|[^\\s,;.]+)`,
    'i',
  )
  const match = rawText.match(pattern)
  const value = match?.[1]
  if (value === undefined) {
    return undefined
  }

  const normalized = stripDirectParameterQuotes(value)
  if (normalized.length === 0) {
    return undefined
  }

  return normalized
}

function listRunbookParameterDefinitions(runbook: RunbookRecord): NonNullable<RunbookAction['parameters']> {
  return runbook.actions.flatMap((action) => action.parameters ?? [])
}

function parameterHasDefaultValue(parameter: NonNullable<RunbookAction['parameters']>[number]): boolean {
  return parameter.defaultValue !== undefined && parameter.defaultValue.trim().length > 0
}

function resolveDirectRunbookParameterValues(
  runbook: RunbookRecord,
  rawText: string,
): RunbookParameterValues | null | undefined {
  const parameters = listRunbookParameterDefinitions(runbook)
  if (parameters.length === 0) {
    return undefined
  }

  const values: RunbookParameterValues = {}
  const parameterKeys = new Set(parameters.map((parameter) => parameter.key))
  const timeWindow = extractNamedJournalTimeWindow(rawText)
  if (timeWindow !== null) {
    if (parameterKeys.has('since')) {
      values.since = timeWindow.since
    }
    if (parameterKeys.has('until')) {
      values.until = timeWindow.until
    }
  }

  for (const parameter of parameters) {
    if (Object.prototype.hasOwnProperty.call(values, parameter.key)) {
      continue
    }

    const value = readDirectParameterValue(rawText, parameter.key)
    if (value !== undefined) {
      values[parameter.key] = value
    }
  }

  const missingRequired = parameters.some(
    (parameter) =>
      parameter.required !== false &&
      !parameterHasDefaultValue(parameter) &&
      values[parameter.key] === undefined,
  )
  if (missingRequired || Object.keys(values).length === 0) {
    return null
  }

  return values
}

function findLatestUserMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') {
      return index
    }
  }

  return -1
}

function toSnapshotAttachments(attachments?: AgentChatAttachment[]): AgentChatAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) {
    return undefined
  }

  return attachments.map((attachment) => ({ ...attachment }))
}

function summarizeRunbookStepTextDetails(
  value: string | undefined,
  maxLength = 220,
): { excerpt: string; length: number; truncated: boolean } | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return undefined
  if (normalized.length <= maxLength) {
    return {
      excerpt: normalized,
      length: normalized.length,
      truncated: false,
    }
  }
  return {
    excerpt: `${normalized.slice(0, maxLength - 1)}…`,
    length: normalized.length,
    truncated: true,
  }
}

function summarizeRunbookStepMarkdownDetails(
  value: string | undefined,
  maxLength = 2500,
): { excerpt: string; length: number; truncated: boolean } | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return undefined
  if (normalized.length <= maxLength) {
    return {
      excerpt: normalized,
      length: normalized.length,
      truncated: false,
    }
  }
  return {
    excerpt: `${normalized.slice(0, maxLength - 1).trimEnd()}…`,
    length: normalized.length,
    truncated: true,
  }
}

function parseRunbookStepStructuredOutput(step: RunbookExecutionStepRecord): Record<string, unknown> | null {
  const structuredOutput = readUnknownRecord(step.structuredOutput)
  if (structuredOutput !== null) {
    return structuredOutput
  }

  if (step.type !== 'plugin' || typeof step.output !== 'string') {
    return null
  }

  const jsonStart = step.output.indexOf('{')
  if (jsonStart === -1) {
    return null
  }

  try {
    return readUnknownRecord(JSON.parse(step.output.slice(jsonStart)) as unknown)
  } catch {
    return null
  }
}

function summarizeRunbookStepStructuredOutput(
  step: RunbookExecutionStepRecord,
): Record<string, unknown> | undefined {
  const structuredOutput = parseRunbookStepStructuredOutput(step)
  const issues = structuredOutput?.issues
  if (!Array.isArray(issues)) {
    return undefined
  }

  const issueSummaries = issues.flatMap((issue) => {
    const record = readUnknownRecord(issue)
    if (record === null) {
      return []
    }

    const summary: Record<string, string | number> = {}
    for (const key of [
      'id',
      'shortId',
      'title',
      'status',
      'count',
      'userCount',
      'firstSeen',
      'lastSeen',
      'level',
    ]) {
      const value = record[key]
      if (typeof value === 'string' || typeof value === 'number') {
        summary[key] = value
      }
    }

    return Object.keys(summary).length > 0 ? [summary] : []
  })

  if (issueSummaries.length === 0) {
    return undefined
  }

  return {
    issues: issueSummaries.slice(0, MAX_STRUCTURED_RUNBOOK_ISSUES),
    issueCount: issueSummaries.length,
    issuesTruncated: issueSummaries.length > MAX_STRUCTURED_RUNBOOK_ISSUES,
  }
}

function formatStructuredIssuePreview(issues: Array<Record<string, unknown>>): string[] {
  return issues.map((issue, index) => {
    const title = readFirstStringProperty([issue], 'title', `Issue ${String(index + 1)}`)
    const details = [
      readStringProperty(issue, 'status'),
      readNumberProperty(issue, 'count'),
      readNumberProperty(issue, 'userCount'),
      readStringProperty(issue, 'level'),
      readStringProperty(issue, 'lastSeen'),
    ].flatMap((value) => (value === null ? [] : [String(value)]))
    const detailsSuffix = details.length > 0 ? ` (${details.join(', ')})` : ''
    return `- ${title}${detailsSuffix}`
  })
}

function readRunbookTimeWindow(value: unknown): { since: string; until: string } | null {
  const record = readUnknownRecord(value)
  if (record === null) {
    return null
  }

  if (typeof record.since !== 'string' || typeof record.until !== 'string') {
    return null
  }

  return { since: record.since, until: record.until }
}

function buildGatewayRunbookRequestKey(
  session: AgentSession,
  runbook: RunbookRecord,
  parameterValues: RunbookParameterValues | undefined,
): string {
  const normalizedParameterValues = Object.fromEntries(
    Object.entries(parameterValues ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  )
  const digest = createHash('sha256')
    .update(JSON.stringify({
      runbookId: runbook.id,
      revisionNumber: runbook.revisionNumber,
      parameterValues: normalizedParameterValues,
    }))
    .digest('hex')

  return `${session.id}:${session.currentTurnId ?? 'unknown-turn'}:${digest}`
}

function padUtcComponent(value: number): string {
  return String(value).padStart(2, '0')
}

function formatJournalUtcTimestamp(value: Date): string {
  return `${String(value.getUTCFullYear())}-${padUtcComponent(value.getUTCMonth() + 1)}-${padUtcComponent(value.getUTCDate())} ${padUtcComponent(value.getUTCHours())}:${padUtcComponent(value.getUTCMinutes())}:${padUtcComponent(value.getUTCSeconds())} UTC`
}

function parseIncidentTimestamp(value: string): Date | null {
  const normalized = value
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})[Tt]/, '$1 ')
    .replace(/ UTC$/, 'Z')
    .replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?!:)(\b.*)$/, '$1 $2:00$3')
    .replace(
      /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(Z|[+-]\d{2}:?\d{2})?$/,
      (_match, datePart: string, timePart: string, timezonePart?: string) =>
        `${datePart}T${timePart}${timezonePart ?? 'Z'}`,
    )
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed
}

function parseIncidentTimestamps(value: string): Date[] {
  return [...value.matchAll(INCIDENT_TIMESTAMP_PATTERN)]
    .map((match) => parseIncidentTimestamp(match[0]))
    .filter((timestamp): timestamp is Date => timestamp != null)
}

function lastIncidentTimestampInText(value: string): Date | null {
  return parseIncidentTimestamps(value).at(-1) ?? null
}

function shouldUseLineForJournalAnchor(value: string): boolean {
  const normalized = value.toLowerCase()
  return (
    normalized.includes('last seen') ||
    normalized.includes('target timestamp') ||
    normalized.includes('event time') ||
    /\btimestamp\b/.test(normalized)
  )
}

function readExecutionTextBlocks(execution: RunbookExecutionRecord): string[] {
  return execution.steps.flatMap((step) => {
    return [step.output, step.error].filter((value): value is string => typeof value === 'string')
  })
}

function buildJournalTimeWindowFromTimestamps(timestamps: Date[]): RunbookParameterValues | undefined {
  if (timestamps.length === 0) {
    return undefined
  }

  const millis = timestamps.map((timestamp) => timestamp.getTime())
  const spanMs = Math.max(...millis) - Math.min(...millis)
  if (spanMs > MAX_DERIVED_JOURNAL_TIME_WINDOW_SPAN_MS) {
    return undefined
  }

  const since = new Date(Math.min(...millis) - JOURNAL_TIME_WINDOW_PADDING_MS)
  const until = new Date(Math.max(...millis) + JOURNAL_TIME_WINDOW_PADDING_MS)

  return {
    since: formatJournalUtcTimestamp(since),
    until: formatJournalUtcTimestamp(until),
  }
}

function extractJournalTimeWindowFromExecution(execution: RunbookExecutionRecord): RunbookParameterValues | undefined {
  const texts = readExecutionTextBlocks(execution)
  const anchorTimestamps = texts.flatMap((text) =>
    text
      .split(/\r?\n/)
      .filter(shouldUseLineForJournalAnchor)
      .map(lastIncidentTimestampInText)
      .filter((timestamp): timestamp is Date => timestamp != null),
  )

  let timestamps = anchorTimestamps
  if (timestamps.length === 0) {
    timestamps = texts.flatMap(parseIncidentTimestamps)
  }

  return buildJournalTimeWindowFromTimestamps(timestamps)
}

function normalizeRunbookOutputCell(value: string): string {
  return value.replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

function firstTimestampInText(value: string): string | null {
  INCIDENT_TIMESTAMP_PATTERN.lastIndex = 0
  return value.match(INCIDENT_TIMESTAMP_PATTERN)?.[0] ?? null
}

function readTimeWindowValue(value: string): string | null {
  const normalized = normalizeRunbookOutputCell(value)
    .replace(/^--?(?:since|until)\s*[:=]?\s*/i, '')
    .replace(/^["']|["']$/g, '')
    .trim()

  if (normalized.length === 0) {
    return null
  }

  return firstTimestampInText(normalized) ?? normalized
}

function splitMarkdownTableRow(line: string): string[] | null {
  if (!line.includes('|')) {
    return null
  }

  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(normalizeRunbookOutputCell)

  if (cells.length < 2) {
    return null
  }

  return cells
}

function isMarkdownTableSeparator(cells: string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function findTableColumn(cells: string[], patterns: RegExp[]): number | null {
  const index = cells.findIndex((cell) => {
    const normalized = cell.toLowerCase()
    return patterns.some((pattern) => pattern.test(normalized))
  })

  if (index < 0) {
    return null
  }

  return index
}

function compactRunbookOutputLabel(value: string): string | undefined {
  const normalized = normalizeRunbookOutputCell(value)
  if (normalized.length === 0) {
    return undefined
  }

  if (normalized.length <= 90) {
    return normalized
  }

  return `${normalized.slice(0, 89)}…`
}

type ActionableJournalTimeWindow = {
  since: string
  until: string
  issue?: string
  timestamp?: string
}

function readActionableJournalTimeWindow(value: unknown): ActionableJournalTimeWindow | null {
  const record = readUnknownRecord(value)
  if (record === null) {
    return null
  }

  if (typeof record.since !== 'string' || typeof record.until !== 'string') {
    return null
  }

  const window: ActionableJournalTimeWindow = {
    since: record.since,
    until: record.until,
  }

  if (typeof record.issue === 'string') {
    window.issue = record.issue
  }

  if (typeof record.timestamp === 'string') {
    window.timestamp = record.timestamp
  }

  return window
}

type JournalWindowTableHeader = {
  sinceIndex: number
  untilIndex: number
  issueIndex?: number
  timestampIndex?: number
}

function readIssueLabelFromLine(line: string): string | undefined {
  let value = normalizeRunbookOutputCell(line).trimStart()
  if (value.startsWith("-") || value.startsWith("*")) value = value.slice(1).trimStart()
  const colon = value.indexOf(":")
  if (colon < 0) return undefined

  const key = value.slice(0, colon).trim().toLowerCase()
  if (key !== "issue" && key !== "fingerprint") return undefined

  const label = value.slice(colon + 1).trim()
  return label === "" ? undefined : compactRunbookOutputLabel(label)
}

function buildActionableJournalTimeWindowFromTimestamp(
  timestamp: Date,
): Pick<ActionableJournalTimeWindow, 'since' | 'until'> {
  return {
    since: formatJournalUtcTimestamp(new Date(timestamp.getTime() - JOURNAL_TIME_WINDOW_PADDING_MS)),
    until: formatJournalUtcTimestamp(new Date(timestamp.getTime() + JOURNAL_TIME_WINDOW_PADDING_MS)),
  }
}

function readTimestampAfterMarker(line: string, marker: string): string | null {
  const markerIndex = line.toLowerCase().indexOf(marker)
  if (markerIndex < 0) {
    return null
  }

  return firstTimestampInText(line.slice(markerIndex))
}

function extractNamedJournalTimeWindow(line: string): Pick<ActionableJournalTimeWindow, 'since' | 'until'> | null {
  const since = readTimestampAfterMarker(line, '--since') ?? readTimestampAfterMarker(line, 'since')
  const until = readTimestampAfterMarker(line, '--until') ?? readTimestampAfterMarker(line, 'until')

  if (since === null || until === null) {
    return null
  }

  return { since, until }
}

function buildJournalWindowFromAnchorLine(line: string, currentIssue: string | undefined): ActionableJournalTimeWindow | null {
  if (!shouldUseLineForJournalAnchor(line)) {
    return null
  }

  const timestamp = lastIncidentTimestampInText(line)
  if (timestamp === null) {
    return null
  }

  const window: ActionableJournalTimeWindow = {
    ...buildActionableJournalTimeWindowFromTimestamp(timestamp),
    timestamp: formatJournalUtcTimestamp(timestamp),
  }

  if (currentIssue !== undefined) {
    window.issue = currentIssue
  }

  return window
}

function readJournalWindowTableHeader(cells: string[]): JournalWindowTableHeader | null {
  const sinceIndex = findTableColumn(cells, [/\bsince\b/, /--since/])
  const untilIndex = findTableColumn(cells, [/\buntil\b/, /--until/])
  if (sinceIndex === null || untilIndex === null) {
    return null
  }

  const issueIndex = findTableColumn(cells, [/\bissue\b/, /\bkey\b/, /\bid\b/, /\berror\b/, /\btitle\b/])
  const timestampIndex = findTableColumn(cells, [/\btimestamp\b/, /\btarget\b/, /\blast seen\b/, /\bevent time\b/])
  const header: JournalWindowTableHeader = {
    sinceIndex,
    untilIndex,
  }

  if (issueIndex !== null) {
    header.issueIndex = issueIndex
  }

  if (timestampIndex !== null) {
    header.timestampIndex = timestampIndex
  }

  return header
}

function readJournalWindowFromTableCells(
  cells: string[],
  tableHeader: JournalWindowTableHeader,
): ActionableJournalTimeWindow | null {
  if (cells.length <= Math.max(tableHeader.sinceIndex, tableHeader.untilIndex)) {
    return null
  }

  const since = readTimeWindowValue(cells[tableHeader.sinceIndex])
  const until = readTimeWindowValue(cells[tableHeader.untilIndex])
  if (since === null || until === null) {
    return null
  }

  const window: ActionableJournalTimeWindow = { since, until }
  if (tableHeader.issueIndex !== undefined) {
    window.issue = compactRunbookOutputLabel(cells[tableHeader.issueIndex])
  }

  if (tableHeader.timestampIndex !== undefined) {
    const timestampCell = cells[tableHeader.timestampIndex]
    window.timestamp = firstTimestampInText(timestampCell) ?? compactRunbookOutputLabel(timestampCell)
  }

  return window
}

function appendNonTableJournalWindow(
  windows: ActionableJournalTimeWindow[],
  line: string,
  currentIssue: string | undefined,
): void {
  const namedWindow = extractNamedJournalTimeWindow(line)
  if (namedWindow !== null) {
    windows.push(namedWindow)
    return
  }
  const anchorWindow = buildJournalWindowFromAnchorLine(line, currentIssue)
  if (anchorWindow !== null) windows.push(anchorWindow)
}

function readJournalWindowFromTableLine(
  line: string,
  cells: string[],
  tableHeader: JournalWindowTableHeader | null,
): { tableHeader: JournalWindowTableHeader | null; window: ActionableJournalTimeWindow | null } {
  const nextTableHeader = readJournalWindowTableHeader(cells)
  if (nextTableHeader !== null) return { tableHeader: nextTableHeader, window: null }
  if (tableHeader === null) {
    return { tableHeader: null, window: extractNamedJournalTimeWindow(line) }
  }
  return { tableHeader, window: readJournalWindowFromTableCells(cells, tableHeader) }
}

function extractJournalTimeWindowsFromText(text: string): ActionableJournalTimeWindow[] {
  const windows: ActionableJournalTimeWindow[] = []
  let tableHeader: JournalWindowTableHeader | null = null
  let currentIssue: string | undefined

  for (const line of text.split(/\r?\n/)) {
    currentIssue = readIssueLabelFromLine(line) ?? currentIssue
    const cells = splitMarkdownTableRow(line)

    if (cells === null) {
      tableHeader = null
      appendNonTableJournalWindow(windows, line, currentIssue)
      continue
    }

    if (isMarkdownTableSeparator(cells)) {
      continue
    }

    const result = readJournalWindowFromTableLine(line, cells, tableHeader)
    tableHeader = result.tableHeader
    if (result.window !== null) windows.push(result.window)
  }

  return windows
}

function extractActionableJournalTimeWindowsFromExecution(
  execution: RunbookExecutionRecord,
): ActionableJournalTimeWindow[] {
  const seen = new Set<string>()
  const windows: ActionableJournalTimeWindow[] = []

  for (const text of readExecutionTextBlocks(execution)) {
    if (text.trim().length === 0) continue
    for (const window of extractJournalTimeWindowsFromText(text)) {
      const dedupeKey = `${window.issue ?? ''}|${window.timestamp ?? ''}|${window.since}|${window.until}`
      if (seen.has(dedupeKey)) {
        continue
      }
      seen.add(dedupeKey)
      windows.push(window)
    }
  }

  return windows
}

function buildAggregateActionableJournalTimeWindow(
  windows: ActionableJournalTimeWindow[],
): RunbookParameterValues | undefined {
  const boundaries = windows.flatMap((window) => [parseIncidentTimestamp(window.since), parseIncidentTimestamp(window.until)])
  const timestamps = boundaries.filter((timestamp): timestamp is Date => timestamp != null)
  if (timestamps.length !== windows.length * 2) {
    return undefined
  }

  const millis = timestamps.map((timestamp) => timestamp.getTime())
  const spanMs = Math.max(...millis) - Math.min(...millis)
  if (spanMs > MAX_DERIVED_JOURNAL_TIME_WINDOW_SPAN_MS) {
    return undefined
  }

  return {
    since: formatJournalUtcTimestamp(new Date(Math.min(...millis))),
    until: formatJournalUtcTimestamp(new Date(Math.max(...millis))),
  }
}

function summarizeRunbookExecutionStep(step: RunbookExecutionStepRecord): Record<string, unknown> {
  const output = summarizeRunbookStepTextDetails(step.output)
  const error = summarizeRunbookStepTextDetails(step.error)
  const structuredOutput = summarizeRunbookStepStructuredOutput(step)
  const summary: Record<string, unknown> = {
    order: step.order,
    title: step.title,
    type: step.type,
    status: step.status,
  }
  if (output !== undefined) {
    summary.outputExcerpt = output.excerpt
    summary.outputLength = output.length
    summary.outputTruncated = output.truncated
  }
  if (error !== undefined) {
    summary.errorExcerpt = error.excerpt
    summary.errorLength = error.length
    summary.errorTruncated = error.truncated
  }
  if (structuredOutput !== undefined) summary.structuredOutput = structuredOutput
  return summary
}

function appendActionableJournalWindowSummary(
  summary: Record<string, unknown>,
  derivedJournalTimeWindow: RunbookParameterValues | undefined,
  actionableJournalTimeWindows: ActionableJournalTimeWindow[],
  aggregateActionableJournalTimeWindow: RunbookParameterValues | undefined,
): void {
  if (derivedJournalTimeWindow !== undefined && actionableJournalTimeWindows.length === 0) {
    summary.derivedJournalTimeWindow = derivedJournalTimeWindow
  }
  if (actionableJournalTimeWindows.length === 0) return
  summary.actionableJournalTimeWindowCount = actionableJournalTimeWindows.length
  if (aggregateActionableJournalTimeWindow !== undefined) {
    summary.aggregateActionableJournalTimeWindow = aggregateActionableJournalTimeWindow
  }
  summary.actionableJournalTimeWindows = actionableJournalTimeWindows.slice(0, MAX_ACTIONABLE_JOURNAL_TIME_WINDOWS)
  if (actionableJournalTimeWindows.length > MAX_ACTIONABLE_JOURNAL_TIME_WINDOWS) {
    summary.actionableJournalTimeWindowsTruncated = true
  }
}

function appendFinalRunbookOutputSummary(
  summary: Record<string, unknown>,
  latestStep: RunbookExecutionStepRecord | undefined,
  latestCompletedOutput: RunbookExecutionStepRecord | undefined,
): void {
  if (latestStep !== undefined) summary.latestStep = summarizeRunbookExecutionStep(latestStep)
  const finalStructuredOutput = latestCompletedOutput === undefined
    ? undefined
    : summarizeRunbookStepStructuredOutput(latestCompletedOutput)
  const finalOutput = finalStructuredOutput === undefined
    ? summarizeRunbookStepTextDetails(latestCompletedOutput?.output, 320)
    : undefined
  const finalOutputMarkdown = finalStructuredOutput === undefined
    ? summarizeRunbookStepMarkdownDetails(latestCompletedOutput?.output)
    : undefined
  if (finalOutput !== undefined) {
    summary.finalOutputExcerpt = finalOutput.excerpt
    summary.finalOutputLength = finalOutput.length
    summary.finalOutputTruncated = finalOutput.truncated
  }
  if (finalOutputMarkdown !== undefined) {
    summary.finalOutputMarkdownExcerpt = finalOutputMarkdown.excerpt
    summary.finalOutputMarkdownLength = finalOutputMarkdown.length
    summary.finalOutputMarkdownTruncated = finalOutputMarkdown.truncated
  }
  if (finalStructuredOutput !== undefined) {
    summary.finalStructuredOutput = finalStructuredOutput
    summary.finalOutputLength = latestCompletedOutput?.output?.trim().length ?? 0
    summary.finalOutputTruncated = true
  }
}

export function summarizeRunbookExecutionForToolOutput(execution: RunbookExecutionRecord): Record<string, unknown> {
  const completedStepCount = execution.steps.filter((step) => step.status === 'completed').length
  const failedStepCount = execution.steps.filter((step) => step.status === 'failed').length
  const latestStep = execution.steps.at(-1)
  const latestCompletedOutput = [...execution.steps]
    .reverse()
    .find((step) => typeof step.output === 'string' && step.output.trim().length > 0)
  const derivedJournalTimeWindow = extractJournalTimeWindowFromExecution(execution)
  const actionableJournalTimeWindows = extractActionableJournalTimeWindowsFromExecution(execution)
  let aggregateActionableJournalTimeWindow: RunbookParameterValues | undefined
  if (actionableJournalTimeWindows.length > 1) {
    aggregateActionableJournalTimeWindow = buildAggregateActionableJournalTimeWindow(actionableJournalTimeWindows)
  }

  const summary: Record<string, unknown> = {
    executionId: execution.executionId,
    runbookId: execution.runbookId,
    runbookTitle: execution.runbookTitle,
    status: execution.status,
    startedAt: execution.startedAt,
    stepCount: execution.steps.length,
    completedStepCount,
    failedStepCount,
    steps: execution.steps.map(summarizeRunbookExecutionStep),
  }

  if (execution.completedAt !== undefined) {
    summary.completedAt = execution.completedAt
  }

  if (execution.completionReason !== undefined) {
    summary.completionReason = execution.completionReason
  }

  if (execution.parameterValues !== undefined) {
    summary.parameterValues = execution.parameterValues
  }

  appendActionableJournalWindowSummary(
    summary, derivedJournalTimeWindow, actionableJournalTimeWindows,
    aggregateActionableJournalTimeWindow,
  )
  appendFinalRunbookOutputSummary(summary, latestStep, latestCompletedOutput)

  return summary
}

function formatRunbookParameterSummary(
  parameters: RunbookParameterSummary[],
): string[] {
  const lines: string[] = []
  for (const parameter of parameters) {
    let line = `- ${parameter.key}`
    if (parameter.required) {
      line += ' (required)'
    }
    if (parameter.defaultValue !== undefined && parameter.defaultValue.length > 0) {
      line += ` default=${parameter.defaultValue}`
    }
    if (parameter.description !== undefined && parameter.description.length > 0) {
      line += ` - ${parameter.description}`
    }
    lines.push(line)
  }
  return lines
}

function readStringProperty(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  if (typeof value !== 'string') {
    return null
  }

  return value
}

function readNumberProperty(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key]
  if (typeof value !== 'number') {
    return null
  }

  return value
}

function readBooleanProperty(record: Record<string, unknown> | null, key: string): boolean {
  return record?.[key] === true
}

function readNonEmptyTrimmedStringProperty(record: Record<string, unknown> | null, key: string): string | null {
  const value = readStringProperty(record, key)
  if (value === null) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  return trimmed
}

function readRecordProperty(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return readUnknownRecord(record?.[key])
}

function readRecordArrayProperty(record: Record<string, unknown> | null, key: string): Array<Record<string, unknown>> {
  const value = record?.[key]
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((item) => {
    const parsed = readUnknownRecord(item)
    if (parsed === null) {
      return []
    }

    return [parsed]
  })
}

type RunbookParameterSummary = {
  key: string
  description?: string
  defaultValue?: string
  required: boolean
}

function readRunbookParameters(parameters: Array<Record<string, unknown>>): RunbookParameterSummary[] {
  return parameters.flatMap((parameter) => {
    const key = readStringProperty(parameter, 'key')
    if (key === null) {
      return []
    }

    const summary: RunbookParameterSummary = {
      key,
      required: parameter.required !== false,
    }
    const description = readStringProperty(parameter, 'description')
    if (description !== null) {
      summary.description = description
    }
    const defaultValue = readStringProperty(parameter, 'defaultValue')
    if (defaultValue !== null) {
      summary.defaultValue = defaultValue
    }

    return [summary]
  })
}

function readRunbookParameterSummaries(runbook: Record<string, unknown>): RunbookParameterSummary[] {
  const catalogParameters = readRunbookParameters(readRecordArrayProperty(runbook, 'parameters'))
  if (catalogParameters.length > 0) {
    return catalogParameters
  }

  return readRecordArrayProperty(runbook, 'actionParameters').flatMap((entry) => {
    const actionTitle = readStringProperty(entry, 'actionTitle')
    if (actionTitle === null) {
      return []
    }

    return readRunbookParameters(readRecordArrayProperty(entry, 'parameters'))
  })
}

function readExecutionSummaryRecord(toolName: string, payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (toolName === 'execute_runbook') {
    return readRecordProperty(payload, 'execution')
  }

  return payload
}

function readFirstStringProperty(
  records: Array<Record<string, unknown> | null>,
  key: string,
  fallback: string,
): string {
  for (const record of records) {
    const value = readStringProperty(record, key)
    if (value !== null) {
      return value
    }
  }

  return fallback
}

function appendOptionalLine(lines: string[], line: string | null): void {
  if (line === null) {
    return
  }

  lines.push(line)
}

/**
 * Agent Runtime Service
 *
 * Manages agentic sessions with tool execution.
 * All execution happens in main process; renderer only receives events.
 */
function formatVisibleRunbookListEntry(runbook: Record<string, unknown>): { title: string; lines: string[] } {
  const title = readFirstStringProperty([runbook], 'title', 'Untitled runbook')
  const actionCount = readNumberProperty(runbook, 'actionCount')
  const actionSummary = actionCount === null
    ? ''
    : ` (${String(actionCount)} ${actionCount === 1 ? 'action' : 'actions'})`
  const description = readNonEmptyTrimmedStringProperty(runbook, 'description')
  return {
    title,
    lines: description === null ? [`- ${title}${actionSummary}`] : [`- ${title}${actionSummary}`, `  ${description}`],
  }
}

export class AgentRuntimeService {
  private sessions = new Map<string, AgentSession>()
  private readonly authoringPersistence = new Map<string, Promise<RunbookRecord>>()

  constructor(
    private windowGetter: () => AgentRuntimeWindow | null,
    private llmAdapter: AgentRuntimeLlmAdapter,
    private readonly runbookGateway?: AgentRuntimeRunbookGateway,
    private readonly debugHooks: AgentRuntimeDebugHooks = DEFAULT_AGENT_RUNTIME_DEBUG_HOOKS,
    private readonly runbookStore?: AgentRuntimeRunbookStore,
    private readonly onRunbooksChanged?: () => void,
    private readonly pluginRuntime?: DesktopPluginRuntimeService,
  ) {}

  /**
   * Start a new agent session.
   *
   * Returns session ID immediately, then runs agent loop asynchronously.
   * This enables real-time event streaming to renderer.
   *
   * @param input - Start input with prompt and optional timeout
   * @returns Session ID (returned immediately, before loop completes)
   */
  start(input: AgentStartInput): Promise<string> {
    if (input.incidentThreadId !== undefined && input.incidentThreadId.length > 0) {
      const existingIncidentSession = this.findActiveIncidentSession(input.incidentThreadId)
      if (existingIncidentSession !== null) {
        return Promise.reject(
          new Error(
            'An agent session is already running for this incident. Wait for it to finish or cancel it before starting another response.',
          ),
        )
      }
    }

    const sessionId = randomUUID()
    const timeoutMs = input.timeoutMs ?? DEFAULT_AGENT_SESSION_TIMEOUT_MS // 5 minutes for thinking models
    const startedAt = new Date()

    log.info(`[agent-runtime:${sessionId}] Starting session with timeout:`, timeoutMs)

    const session: AgentSession = {
      id: sessionId,
      state: 'RUNNING',
      startedAt,
      expiresAt: startedAt.getTime() + timeoutMs,
      abortController: new AbortController(),
      timeoutHandle: null,
      currentToolCallId: null,
      queuedFollowUps: [],
      windowGetter: this.windowGetter,
      llmAdapter: this.llmAdapter,
      runbookContext: input.runbookContext,
      llmSelection: input.llm,
      accessLevel: input.accessLevel,
      traitValues: input.traitValues,
      incidentThreadId: input.incidentThreadId,
      runbookAuthoringProposals: [],
      messages: [
        {
          role: 'system',
          content: this.buildSystemPrompt(input.runbookContext),
        },
        {
          role: 'user',
          content: createUserMessageContent(input.prompt, input.attachments),
        },
      ],
      snapshot: createAgentThreadSnapshot({
        sessionId,
        startedAt: startedAt.toISOString(),
        runtimeState: 'RUNNING',
        prompt: input.prompt,
        attachments: toSnapshotAttachments(input.attachments),
      }),
    }

    this.sessions.set(sessionId, session)
    this.armSessionTimeout(session, timeoutMs)

    this.runAgentLoop(session)
      .catch((error: unknown) => {
        log.error(`[agent-runtime:${sessionId}] Unhandled loop error:`, error)
      })

    return Promise.resolve(sessionId)
  }

  /**
   * Send a follow-up message to an existing session.
   *
   * Returns session ID immediately, then runs loop asynchronously.
   *
   * @param input - Send input with message and optional session ID
   * @returns Session ID (new or existing)
   */

  send(input: AgentSendInput): Promise<string> {
    let sessionId = input.sessionId ?? randomUUID()

    let session = this.sessions.get(sessionId)

    if (session === undefined && input.incidentThreadId !== undefined && input.incidentThreadId.length > 0) {
      const incidentSession = this.findMostRecentIncidentSession(input.incidentThreadId)
      if (incidentSession !== null) {
        session = incidentSession
        sessionId = incidentSession.id
      }
    }

    if (session === undefined) {
      return this.start({
        prompt: input.message,
        attachments: input.attachments,
        llm: input.llm,
        runbookContext: input.runbookContext,
        incidentThreadId: input.incidentThreadId,
        accessLevel: input.accessLevel,
        traitValues: input.traitValues,
      })
    }

    if (session.state === 'RUNNING' && session.loopActive === true) {
      // Preserve user intent while the current model turn or runbook summary
      // owns the loop. The queued message is appended after that turn finishes.
      session.queuedFollowUps.push(input)
      return Promise.resolve(sessionId)
    }

    if (session.state !== 'RUNNING') {
      session = this.prepareSessionForContinuation(session)
    }

    log.info(`[agent-runtime:${sessionId}] Continuing session with message:`, input.message)

    if (input.runbookContext !== undefined) {
      session.runbookContext = input.runbookContext
    }
    if (input.llm !== undefined) {
      session.llmSelection = input.llm
    }
    if (input.accessLevel !== undefined) {
      session.accessLevel = input.accessLevel
    }
    if (input.traitValues !== undefined) {
      session.traitValues = input.traitValues
    }
    if (input.incidentThreadId !== undefined && input.incidentThreadId.length > 0) {
      session.incidentThreadId = input.incidentThreadId
    }

    // Add user message to history
    session.messages.push({
      role: 'user',
      content: createUserMessageContent(input.message, input.attachments),
    })
    session.snapshot = appendPromptToThreadSnapshot(session.snapshot, {
      prompt: input.message,
      attachments: toSnapshotAttachments(input.attachments),
      runtimeState: session.state,
    })

    this.armSessionTimeout(session, DEFAULT_AGENT_SESSION_TIMEOUT_MS)

    this.runAgentLoop(session).catch((error: unknown) => {
      log.error(`[agent-runtime:${sessionId}] Unhandled loop error:`, error)
    })

    return Promise.resolve(sessionId)
  }

  /**
   * Cancel an active session.
   *
   * @param sessionId - Session ID to cancel
   */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      return
    }

    log.info(`[agent-runtime:${sessionId}] Cancelling session`)
    this.clearSessionTimeout(session)
    session.abortController.abort()
    session.state = 'CANCELLED'
    session.snapshot = setAgentThreadRuntimeState(session.snapshot, 'CANCELLED')

    this.sendEvent(sessionId, {
      type: 'cancelled',
      timestamp: new Date().toISOString(),
      message: 'Session cancelled by user or timeout',
    })
  }

  /**
   * Get session status snapshot.
   *
   * @param sessionId - Session ID
   * @returns Session status or throws if not found
   */
  getStatus(sessionId: string): AgentSessionStatus {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return {
      sessionId: session.id,
      state: session.state,
      startedAt: session.startedAt.toISOString(),
      currentToolCallId: session.currentToolCallId,
    }
  }

  getSnapshot(sessionId: string): AgentThreadSnapshot {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    return session.snapshot
  }

  listRunbookAuthoringProposals(input: { sessionId?: string; incidentThreadId?: string }): RunbookAuthoringProposalReview[] {
    return this.resolveRunbookAuthoringSessions(input).flatMap((session) => session.runbookAuthoringProposals.map((proposal) => this.summarizeRunbookAuthoringProposal(proposal)))
  }

  async approveRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; approvedOperationIds?: string[] }): Promise<RunbookAuthoringProposalDecisionResult> {
    const { session, proposal, proposalIndex } = this.resolveRunbookAuthoringProposal(input)
    if (proposal.kind === 'edit_existing_runbook') {
      const latest = await this.resolveCurrentRunbookForAuthoringApproval(proposal)
      if (getRunbookAuthoringRevisionHash(latest) !== proposal.targetRevisionHash) throw new Error('This runbook changed after the authoring proposal was created. Ask the agent to revise the proposal against the latest runbook before approving it.')
    }
    const approval = approveRunbookAuthoringProposal({ proposal, approvedOperationIds: input.approvedOperationIds })
    const savedRunbook = await this.persistApprovedRunbookAuthoringProposal(approval.runbook, proposal)
    session.runbookAuthoringProposals[proposalIndex] = approval.proposal
    this.appendRunbookAuthoringDecisionNote(session, {
      proposal: approval.proposal,
      decision: 'approved',
      savedRunbook,
    })
    this.onRunbooksChanged?.()
    return { proposal: this.summarizeRunbookAuthoringProposal(approval.proposal), savedRunbook, approvedOperationIds: approval.approvedOperationIds }
  }

  rejectRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; reason?: string }): RunbookAuthoringProposalDecisionResult {
    const { session, proposal, proposalIndex } = this.resolveRunbookAuthoringProposal(input)
    const rejection = rejectRunbookAuthoringProposal({ proposal, reason: input.reason })
    session.runbookAuthoringProposals[proposalIndex] = rejection.proposal
    this.appendRunbookAuthoringDecisionNote(session, {
      proposal: rejection.proposal,
      decision: 'rejected',
      reason: rejection.reason,
    })
    return { proposal: this.summarizeRunbookAuthoringProposal(rejection.proposal), reason: rejection.reason }
  }

  requestRunbookAuthoringRevision(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; requestedEdit: string }): RunbookAuthoringProposalDecisionResult {
    const { session, proposal, proposalIndex } = this.resolveRunbookAuthoringProposal(input)
    const revision = requestRunbookAuthoringRevision({ proposal, requestedEdit: input.requestedEdit })
    session.runbookAuthoringProposals[proposalIndex] = revision.proposal
    this.appendRunbookAuthoringDecisionNote(session, {
      proposal: revision.proposal,
      decision: 'revision_requested',
      requestedEdit: revision.requestedEdit,
    })
    return { proposal: this.summarizeRunbookAuthoringProposal(revision.proposal), requestedEdit: revision.requestedEdit }
  }

  /**
   * Build the system prompt for the LLM.
   * @param runbookContext - Optional runbook context for contextualized responses
   */

  private buildSystemPrompt(
    runbookContext?: RunbookContext,
    options: {
      includeRunbookResultInstructions?: boolean
      includeRunbookParameterInstructions?: boolean
      includeMultipleRunbookInstructions?: boolean
    } = {},
  ): string {
    const isSshRelated = runbookContext?.actions.some((a) => a.type === 'shell') ?? false
    const hasHttpAction = runbookContext?.actions.some((a) => a.type === 'http') ?? false
    const hasShellAction = runbookContext?.actions.some((a) => a.type === 'shell') ?? false
    const hasLlmAction = runbookContext?.actions.some((a) => a.type === 'llm') ?? false

    const baseInstructions = [
      'You are a security operations assistant for BitSentry Desktop.',
      '',
      'You are participating in a continuous, multi-turn conversation.',
      'You have full access to the message history above. Do NOT claim you cannot remember previous turns.',
      '',
    ]

    this.appendSshInstructions(baseInstructions, isSshRelated)

    this.appendRunbookToolInstructions(baseInstructions, options)

    // Instructions for runbook action execution
    if (runbookContext !== undefined) {
      const executionCapabilities: string[] = []
      if (hasHttpAction) executionCapabilities.push('execute_http_request')
      if (hasShellAction) executionCapabilities.push('execute_shell_command')
      if (hasLlmAction) executionCapabilities.push('perform LLM analysis directly')
      if (this.hasRunbookTools()) executionCapabilities.push('execute_runbook (runbookId)')

      if (executionCapabilities.length > 0) {
        baseInstructions.push(
          'You CAN execute runbook actions using the following tools:',
          ...executionCapabilities.map((c) => `- ${c}`),
          '',
        )
      }
    }

    baseInstructions.push(
      'Tool results are internal context. Do not paste raw JSON, transcript labels, or tool wrappers into the user-facing response unless the user explicitly asks for raw output.',
      '',
      'If you cannot fulfill a request, explain why clearly.',
    )

    if (runbookContext !== undefined) {
      return this.buildRunbookContextPrompt(baseInstructions, runbookContext)
    }

    return baseInstructions.join('\n')
  }

  private appendRunbookToolInstructions(
    baseInstructions: string[],
    options: {
      includeRunbookResultInstructions?: boolean
      includeRunbookParameterInstructions?: boolean
      includeMultipleRunbookInstructions?: boolean
    },
  ): void {
    if (!this.hasRunbookTools()) return

    baseInstructions.push(
      'Do not claim a runbook was created, edited, updated, or saved unless a user approved a proposal and the save operation succeeded.',
      'After starting a runbook, call get_runbook_execution exactly once with waitForCompletion: true to obtain its terminal result or its latest snapshot after 30 seconds. You may omit executionId to use the latest runbook execution for this incident.',
      'Do not claim a runbook was executed unless execute_runbook succeeded.',
      '',
    )

    if (options.includeRunbookParameterInstructions === true) {
      baseInstructions.push(
        'If the user specifies values for runbook placeholders such as time windows, host fragments, usernames, service names, or IDs, pass them in execute_runbook.parameterValues.',
        'If list_runbooks shows required parameters, do not start that runbook until you supply them.',
        'Runbook parameter defaults are fallback values only when the user did not specify a value.',
        '',
      )
    }

    if (options.includeMultipleRunbookInstructions === true) {
      baseInstructions.push(
        'For incident diagnosis requests that require multiple data sources, decide which runbooks are needed, execute each required runbook, then inspect completed results before finalizing.',
        '',
      )
    }

    if (options.includeRunbookResultInstructions === true) {
      baseInstructions.push(
        'When prior runbook results provide a combined journalctl window, run the backend log runbook once with that combined since/until instead of starting one runbook per issue row.',
        'When prior runbook results list only individual actionable journalctl windows, use those exact since/until values in execute_runbook.parameterValues for the backend log runbook; do not ask the user to paste timestamps you already received.',
        'If you inspect a runbook in the same assistant response that starts it, omit executionId so the runtime can use the execution that actually started.',
        'Do not final-answer from a runbook start acknowledgement alone when the user asked for cross-validation, matrices, or RCA.',
        'If a later runbook fails, prefer the successful runbook results already present in this incident instead of restarting the entire investigation.',
        '',
      )
    }
  }

  private appendSshInstructions(baseInstructions: string[], isSshRelated: boolean): void {
    if (!isSshRelated) return

    baseInstructions.push(
      'You have access to tools for collecting logs from Linux servers via SSH.',
      'Always use tools when users request log collection or server diagnostics.',
      '',
      'CRITICAL: Tool parameters must be passed as top-level JSON fields, NOT wrapped in a string.',
      'Correct: { "host": "192.168.1.10", "username": "ubuntu", "since": "1 hour ago" }',
      'Wrong: { "input": "host: 192.168.1.10..." }',
      '',
      'When a user asks for logs, use the ssh_journal_query tool with:',
      '- host: IP address or hostname',
      '- username: SSH username',
      '- since: Time range (e.g., "1 hour ago", "2026-01-01 00:00:00 UTC")',
      '- For time windows, do NOT use ISO timestamps with "T" or "Z". Prefer "YYYY-MM-DD HH:mm:ss UTC" or a relative value like "1 hour ago".',
      '',
    )
  }

  private refreshSystemPromptForRunbookResults(session: AgentSession): void {
    if (
      session.latestRunbookExecutionId === undefined &&
      session.hasRunbookParameters !== true &&
      session.hasMultipleRunbooksInPlay !== true
    ) {
      return
    }

    const systemMessage = session.messages.find((message) => message.role === 'system')
    if (systemMessage === undefined || typeof systemMessage.content !== 'string') {
      return
    }

    systemMessage.content = this.buildSystemPrompt(session.runbookContext, {
      includeRunbookResultInstructions: session.latestRunbookExecutionId !== undefined,
      includeRunbookParameterInstructions: session.hasRunbookParameters === true,
      includeMultipleRunbookInstructions: session.hasMultipleRunbooksInPlay === true,
    })
  }

  private buildRunbookContextPrompt(
    baseInstructions: string[],
    runbookContext: RunbookContext,
  ): string {
    const runbookInstructions: string[] = [
        '',
        '--- ACTIVE RUNBOOK CONTEXT ---',
        'The runbook context below IS provided to you. You CAN and MUST reference it.',
        'Do NOT claim you do not have access to "internal documents" or "the runbook".',
        '',
        `Runbook: ${runbookContext.title}`,
    ]

    if (runbookContext.description.length > 0) {
      runbookInstructions.push(`Description: ${runbookContext.description}`)
    }

    runbookInstructions.push(
        '',
        'Runbook Actions:',
        ...runbookContext.actions.map(formatRunbookActionPromptBlock),
        '',
    )
    appendRunbookToolPromptLines(runbookInstructions, runbookContext.id, this.hasRunbookTools())
    runbookInstructions.push(
        '',
        '--- HOW TO HANDLE EACH ACTION TYPE ---',
        'For [llm] actions: YOU are the LLM. Perform the requested analysis or summarization DIRECTLY in your response.',
        'Example: For "Summarize incidents", write the actual summary - not "I will summarize".',
        '',
        'For [http] actions: Use the execute_http_request tool with url and method.',
        'For [shell] actions: Use the execute_shell_command tool with the command.',
        'For [external_source] actions: These require user-provided results - you cannot execute them directly.',
        '',
        '--- IMPORTANT: COMPLETE YOUR RESPONSE ---',
        'CRITICAL: Never stop mid-response. After stating what you will do, you MUST actually do it.',
        'For LLM actions: perform the analysis directly in your response - do not just say you will analyze it.',
        '',
        'In your response, make sure to:',
        '1. Reference the specific runbook actions',
        '2. Provide your actual analysis (not just "I will analyze")',
        '3. Tie your conclusion back to this runbook: "' + runbookContext.title + '"',
        '',
        'Do NOT stop after explaining your plan. Complete the full analysis.',
        '--- END RUNBOOK CONTEXT ---',
    )

    return [...baseInstructions, ...runbookInstructions].join('\n')
  }

  /**
   * Run the agent loop: LLM -> tool calls -> results -> repeat.
   *
   * Implements full tool-call loop:
   * 1. Call LLM with current messages
   * 2. If tool calls returned: validate -> execute tools -> append results to messages -> repeat
   * 3. Stop when no tool calls returned or max iterations reached
   *
   * @param session - Active session
   */
  // eslint-disable-next-line sonarjs/cognitive-complexity -- This cancellation, streaming, and tool-execution state machine must retain its ordered transitions.
  private async runAgentLoop(session: AgentSession): Promise<void> {
    const { id: sessionId, abortController, llmAdapter } = session
    session.loopActive = true

    try {
      session.currentTurnRunbookExecutionLookups = new Set()
      session.currentTurnStartedRunbookExecutionIds = new Set()
      session.currentTurnHostToolCalls = new Map()
      session.currentTurnVisibleRunbookExecutionIds = new Set()
      session.currentTurnId = randomUUID()
      let iterations = 0
      let lastToolResult: ToolResult | undefined
      let turnTokenUsage: TurnTokenUsage | undefined
      let postToolFallbackResults: CompletedToolResult[] | null = null
      let awaitingRunbookSummary = false
      const visibleRunbookExecutionIds = new Set<string>()
      const accumulateTurnTokenUsage = (usage: TurnTokenUsage): void => {
        turnTokenUsage = mergeTurnTokenUsage(turnTokenUsage, usage)
      }

      const emitFinal = (response: string): void => {
        session.state = 'COMPLETED'
        this.sendEvent(sessionId, {
          type: 'final',
          timestamp: new Date().toISOString(),
          response,
          tokenUsage: turnTokenUsage,
        })
      }
      const endThinking = (): void => {
        this.sendEvent(sessionId, {
          type: 'thinking_end',
          timestamp: new Date().toISOString(),
        })
      }

      const directRunbookExecution = await this.runExplicitlyMentionedRunbook(session)
      if (directRunbookExecution !== null) {
        awaitingRunbookSummary = true
        lastToolResult = directRunbookExecution.result
        this.sendEvent(sessionId, {
          type: 'tool_start',
          timestamp: new Date().toISOString(),
          toolName: directRunbookExecution.toolCall.name,
          toolCallId: directRunbookExecution.toolCall.id,
          input: directRunbookExecution.toolCall.args,
        })
        this.sendEvent(sessionId, {
          type: 'tool_end',
          timestamp: new Date().toISOString(),
          toolCallId: directRunbookExecution.toolCall.id,
          state: getToolEndState(directRunbookExecution.result),
          output: directRunbookExecution.result.output,
          error: directRunbookExecution.result.error,
          modelContext: directRunbookExecution.modelContext,
        })
        session.messages.push({
          role: 'system',
          content: directRunbookExecution.modelContext,
        })

        if (directRunbookExecution.visibleResult !== null) {
          this.sendEvent(sessionId, {
            type: 'assistant_delta',
            timestamp: new Date().toISOString(),
            delta: directRunbookExecution.visibleResult.text,
            kind: 'command_output',
          })
        }
      }

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++
        const observedIteration = {
          textDelta: false,
          tokenUsage: undefined as TurnTokenUsage | undefined,
        }
        const fallbackResultsForThisLlmCall = postToolFallbackResults
        postToolFallbackResults = null

        if (isAbortSignalAborted(abortController.signal)) {
          session.state = 'CANCELLED'
          return
        }

        this.sendEvent(sessionId, {
          type: 'activity',
          timestamp: new Date().toISOString(),
          phase: awaitingRunbookSummary ? 'waiting_for_summary' : 'asking_model',
        })

        this.refreshSystemPromptForRunbookResults(session)

        // Determine which tools should be available based on runbook actions
        const hasShellAction = session.runbookContext?.actions.some((a) => a.type === 'shell') ?? false
        const hasHttpAction = session.runbookContext?.actions.some((a) => a.type === 'http') ?? false

        // SSH tools - only available when runbook has shell actions
        const sshToolNames = ['ssh_journal_query', 'list_log_sources', 'get_checkpoint']

        // Get tool definitions for LLM, filtering based on runbook actions
        const toolDefinitions = getAllToolDefinitions()
          .filter((tool) => {
            if (tool.name === 'execute_shell_command') return hasShellAction
            if (tool.name === 'execute_http_request') return hasHttpAction
            // SSH tools only when shell action exists
            if (sshToolNames.includes(tool.name)) return hasShellAction
            // Other tools (if any) are always available
            return true
          })
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: zodToJsonSchema(tool.inputSchema as never),
          }))
          .concat(this.getDynamicToolDefinitions())

        log.info(`[agent-runtime:${sessionId}] LLM call iteration ${String(iterations)}, messages: ${String(session.messages.length)}`)

        const localCodingAgentProviderKey = getLocalCodingAgentProviderKey(session.llmSelection)
        const isLocalCodingAgentProvider = localCodingAgentProviderKey !== null
        const hasVisiblePostToolResult = this.hasVisibleRunbookToolResult(fallbackResultsForThisLlmCall)
        const shouldEmitThinkingStart = !(isLocalCodingAgentProvider && hasVisiblePostToolResult)
        if (shouldEmitThinkingStart) {
          this.sendEvent(sessionId, {
            type: 'thinking_start',
            timestamp: new Date().toISOString(),
          })
        }

        // Call LLM
        const shouldEmitAssistantDeltas =
          !isLocalCodingAgentProvider ||
          this.debugHooks.isLocalCodingAgentDeltaStreamingEnabled()
        const remainingSessionTimeoutMs = Math.max(1, session.expiresAt - Date.now())
        const response: Awaited<ReturnType<AgentLlmAdapterService['chatWithTools']>> = await runOrchestratedOperation({
            operation: 'LLM response',
            signal: abortController.signal,
            timeoutMs: remainingSessionTimeoutMs,
            execute: (signal) =>
              llmAdapter.chatWithTools({
                messages: session.messages,
                tools: toolDefinitions,
                signal,
                llm: session.llmSelection,
                accessLevel: session.accessLevel,
                traitValues: session.traitValues,
                hostToolContext: this.hasRunbookTools()
                  ? this.createHostToolContext(session, { observeEvents: true })
                  : undefined,

            onDelta: (delta) => {
              // Stream assistant deltas to renderer
              if (delta.type === 'text') {
                const deltaText = delta.text
                if (deltaText !== undefined && deltaText.length > 0) {
                  observedIteration.textDelta = true
                  if (localCodingAgentProviderKey !== null) {
                    this.debugHooks.recordCodingAgentDebugEvent('agent_runtime.delta_emitted', {
                      provider: localCodingAgentProviderKey,
                      sessionId,
                      deltaLength: deltaText.length,
                    })
                  }
                  if (shouldEmitAssistantDeltas) {
                    this.sendEvent(sessionId, {
                      type: 'assistant_delta',
                      timestamp: new Date().toISOString(),
                      delta: deltaText,
                    })
                  }
                }
              } else if (delta.type === 'token_usage') {
                observedIteration.tokenUsage = delta.tokenUsage
                this.sendEvent(sessionId, {
                  type: 'token_usage',
                  timestamp: new Date().toISOString(),
                  tokenUsage: delta.tokenUsage,
                })
              }
                },
              }),
          })

        const toolResponseFallbackText = this.buildVisibleRunbookFallbackResponse(
          fallbackResultsForThisLlmCall,
          response.content,
        )
        let responseContent = response.content
        if (
          isLocalCodingAgentProvider &&
          hasVisiblePostToolResult &&
          response.toolCalls?.length === 0 &&
          toolResponseFallbackText !== ''
        ) {
          responseContent = joinNonEmptyBlocks(
            response.content,
            toolResponseFallbackText,
          )
        }

        if (responseContent.length > 0 && !observedIteration.textDelta) {
          if (localCodingAgentProviderKey !== null) {
            this.debugHooks.recordCodingAgentDebugAnomaly('agent_runtime.fallback_final_text', {
              provider: localCodingAgentProviderKey,
              sessionId,
              finalTextLength: responseContent.length,
            })
          }
          if (shouldEmitAssistantDeltas) {
            this.sendEvent(sessionId, {
              type: 'assistant_delta',
              timestamp: new Date().toISOString(),
              delta: responseContent,
            })
          }
        }

        // Sum token usage across every LLM round-trip in this turn so the final
        // event reflects the full cost of the tool loop, not just the last hop.
        if (response.tokenUsage !== undefined) {
          accumulateTurnTokenUsage(response.tokenUsage)
        } else if (observedIteration.tokenUsage !== undefined) {
          accumulateTurnTokenUsage(observedIteration.tokenUsage)
        }

        if (shouldEmitThinkingStart) {
          endThinking()
        }

        // Add assistant response to history
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: responseContent,
        }

        let toolCalls: ToolCall[] = []
        if (response.toolCalls !== undefined) {
          toolCalls = this.dedupeToolCalls(session, response.toolCalls)
        }

        const observedHostToolCalls = this.takeCompletedHostToolCalls(session)
        if (toolCalls.length > 0) {
          assistantMessage.toolCalls = toolCalls
        } else if (observedHostToolCalls.length > 0) {
          assistantMessage.toolCalls = observedHostToolCalls.map(({ toolCall }) => toolCall)
        }

        session.messages.push(assistantMessage)

        for (const { toolCall, result, modelContext } of observedHostToolCalls) {
          session.messages.push({
            role: 'tool',
            content: modelContext,
            toolCallId: toolCall.id,
            toolResult: createAgentToolResultEnvelope(toolCall, result),
          })
        }

        if (response.toolProtocol === 'mcp') {
          if (toolCalls.length > 0) {
            throw new Error('MCP providers must execute host tools through the MCP server, not return tool calls')
          }
          emitFinal(responseContent)
          return
        }

        // If no tool calls, we're done with this turn but keep session RUNNING for follow-ups
        if (toolCalls.length === 0) {
          emitFinal(responseContent)
          return
        }

        const hasRunbookStartInBatch = toolCalls.some((toolCall) => toolCall.name === 'execute_runbook')
        let runbookStartCompletedInBatch = false

        const executedToolResults: Array<CompletedToolResult | null> = []

        for (const toolCall of toolCalls) {
          if (isAbortSignalAborted(abortController.signal)) {
            session.state = 'CANCELLED'
            break
          }

          session.currentToolCallId = toolCall.id

          let result: ToolResult
          if (
            this.shouldDeferRunbookLookupInBatch(
              session,
              toolCall,
              hasRunbookStartInBatch,
              runbookStartCompletedInBatch,
            )
          ) {
            this.sendEvent(sessionId, {
              type: 'tool_start',
              timestamp: new Date().toISOString(),
              toolName: toolCall.name,
              toolCallId: toolCall.id,
              input: toolCall.args,
            })
            result = this.buildDeferredRunbookLookupResult(toolCall)
          } else {
            result = await this.executeToolCall(session, toolCall)
          }

          if (session.currentToolCallId === toolCall.id) {
            session.currentToolCallId = null
          }

          const modelContext = this.buildToolConversationContent(toolCall, result)
          const toolEndEvent: AgentEventData = {
            type: 'tool_end',
            timestamp: new Date().toISOString(),
            toolCallId: toolCall.id,
            state: getToolEndState(result),
            output: result.output,
            error: result.error,
          }

          if (this.isDynamicToolName(toolCall.name)) {
            toolEndEvent.modelContext = modelContext
          }

          this.sendEvent(sessionId, toolEndEvent)

          let visibleRunbookResult: VisibleRunbookToolResult | null = null
          if (isLocalCodingAgentProvider) {
            visibleRunbookResult = this.buildVisibleRunbookToolResult({ toolCall, result, modelContext })
          }

          if (visibleRunbookResult !== null) {
            let shouldEmitVisibleRunbookResult = true
            if (visibleRunbookResult.executionId !== undefined) {
              shouldEmitVisibleRunbookResult = !visibleRunbookExecutionIds.has(visibleRunbookResult.executionId)
            }

            // list_runbooks is already summarized by the assistant response. Keep the
            // tool card/model context visible, but do not also stream the raw list into
            // the same assistant iteration where the summary is rendered.
            if (shouldEmitVisibleRunbookResult && toolCall.name !== 'list_runbooks') {
              if (visibleRunbookResult.executionId !== undefined) {
                visibleRunbookExecutionIds.add(visibleRunbookResult.executionId)
              }
              this.sendEvent(sessionId, {
                type: 'assistant_delta',
                timestamp: new Date().toISOString(),
                delta: visibleRunbookResult.text,
                kind: 'command_output',
              })
            }
          }

          if (result.error !== undefined && result.error.length > 0) {
            // Tool failed - inform LLM and let it decide what to do
            log.warn(`[agent-runtime:${sessionId}] Tool ${toolCall.name} failed:`, result.error)
          }

          if (toolCall.name === 'execute_runbook' && result.error === undefined) {
            runbookStartCompletedInBatch = true
            awaitingRunbookSummary = true
          }

          executedToolResults.push({ toolCall, result, modelContext })
        }

        if (isAbortSignalAborted(abortController.signal)) {
          session.state = 'CANCELLED'
          return
        }

        const completedToolResults = executedToolResults.filter(
          (entry): entry is CompletedToolResult => entry !== null,
        )
        lastToolResult = completedToolResults[completedToolResults.length - 1]?.result

        for (const { toolCall, result, modelContext } of completedToolResults) {
          session.messages.push({
            role: 'tool',
            content: modelContext,
            toolCallId: toolCall.id,
            toolResult: createAgentToolResultEnvelope(toolCall, result),
          })
        }

        const deferredRunbookResponse = this.buildDeferredRunbookResponse(completedToolResults)
        if (deferredRunbookResponse !== null) {
          session.currentToolCallId = null
          emitFinal(deferredRunbookResponse)
          return
        }

        postToolFallbackResults = this.hasVisibleRunbookToolResult(completedToolResults)
          ? completedToolResults
          : null

        // Trim message history if it's getting too long
        if (session.messages.length > MAX_MESSAGE_HISTORY) {
          // Keep system message and recent messages
          const systemMessage = session.messages.find((m) => m.role === 'system')
          const recentMessages = session.messages.slice(-MAX_MESSAGE_HISTORY)
          if (systemMessage !== undefined) {
            session.messages = [systemMessage, ...recentMessages.filter((m) => m.role !== 'system')]
          } else {
            session.messages = recentMessages
          }
        }
      }

      // Max iterations reached
      log.warn(`[agent-runtime:${sessionId}] Max iterations (${String(MAX_TOOL_ITERATIONS)}) reached`)

      let finalResponse = `Completed ${String(iterations)} iterations without final response.`
      if (lastToolResult?.output !== undefined && lastToolResult.output.length > 0) {
        finalResponse = `Completed ${String(iterations)} iterations. Last output: ${lastToolResult.output.slice(0, 200)}...`
      }
      emitFinal(finalResponse)
    } catch (error) {
      const message = getErrorMessage(error)
      log.error(`[agent-runtime:${sessionId}] Agent loop error:`, message)

      session.state = 'FAILED'
      session.snapshot = setAgentThreadRuntimeState(session.snapshot, 'FAILED')
      session.currentToolCallId = null
      this.sendEvent(sessionId, {
        type: 'error',
        timestamp: new Date().toISOString(),
        message,
        code: getAgentErrorCode(message),
      })
    } finally {
      this.clearSessionTimeout(session)
      session.loopActive = false
      session.currentTurnRunbookExecutionLookups = undefined
      session.currentTurnStartedRunbookExecutionIds = undefined
      session.currentTurnHostToolCalls = undefined
      session.currentTurnVisibleRunbookExecutionIds = undefined
      session.currentTurnId = undefined
      const queuedFollowUp = session.queuedFollowUps.shift()
      if (queuedFollowUp !== undefined && session.state !== 'CANCELLED') {
        void this.send({ ...queuedFollowUp, sessionId: session.id }).catch((error: unknown) => {
          log.error(`[agent-runtime:${session.id}] Queued follow-up failed:`, error)
        })
      }
    }
  }

  /**
   * Execute a single tool call.
   *
   * @param session - Active session
   * @param toolCall - Tool call from LLM
   * @returns Tool result
   */
  private async executeToolCall(session: AgentSession, toolCall: ToolCall): Promise<ToolResult> {
    const { id: sessionId, abortController } = session
    const { id: toolCallId, name: toolName, args } = toolCall
    let toolStartSent = false

    const emitToolStart = () => {
      if (toolStartSent) return
      toolStartSent = true
      this.sendEvent(sessionId, {
        type: 'tool_start',
        timestamp: new Date().toISOString(),
        toolName,
        toolCallId,
        input: args,
      })
    }

    log.info(`[agent-runtime:${sessionId}] Executing tool:`, {
      toolCallId,
      toolName,
      args,
    })

    try {
      if (this.isDynamicToolName(toolName)) {
        emitToolStart()
      }

      const dynamicToolResult = await this.executeDynamicToolCall(session, toolCall)
      if (dynamicToolResult !== null) {
        return dynamicToolResult
      }

      const toolDef = getTool(toolName)
      if (toolDef === undefined) {
        throw new Error(`Unknown tool: ${toolName}`)
      }

      emitToolStart()

      // Normalize args before validation (handles LLM wrapping params in 'input' string)
      const normalizedArgs = normalizeToolArgs(toolName, args)
      const validatedInput = validateToolInput(toolName, normalizedArgs)

      const context: ToolContext = {
        sessionId,
        toolCallId,
        signal: abortController.signal,
        onChunk: (chunk: string) => {
          this.sendEvent(sessionId, {
            type: 'tool_update',
            timestamp: new Date().toISOString(),
            toolCallId,
            chunk: truncateToolChunk(chunk),
            truncationWarning: chunk.length > 1000,
          })
        },
      }

      return await toolDef.execute(validatedInput, context)
    } catch (error) {
      const message = getErrorMessage(error)
      log.error(`[agent-runtime:${sessionId}] Tool execution error:`, message)
      return { error: message }
    }
  }

  /**
   * Send an event to the renderer.
   *
   * @param sessionId - Session ID
   * @param event - Event data
   */
  private sendEvent(sessionId: string, event: AgentEventData): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) {
      session.snapshot = reduceAgentThreadSnapshot(setAgentThreadRuntimeState(session.snapshot, session.state), event)
      session.snapshot = {
        ...session.snapshot,
        currentToolCallId: session.currentToolCallId,
      }
    }

    const win = this.windowGetter()
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(CHANNEL_EVENT, {
        sessionId,
        event,
        snapshot: session?.snapshot,
      })
    } else {
      log.warn(`[agent-runtime:${sessionId}] No window to send event:`, event.type)
    }
  }

  private armSessionTimeout(session: AgentSession, timeoutMs: number): void {
    this.clearSessionTimeout(session)
    session.expiresAt = Date.now() + timeoutMs
    session.timeoutHandle = setTimeout(() => { this.handleSessionTimeout(session.id); }, timeoutMs)
  }

  private clearSessionTimeout(session: AgentSession): void {
    if (session.timeoutHandle === null) {
      return
    }

    clearTimeout(session.timeoutHandle)
    session.timeoutHandle = null
  }

  private handleSessionTimeout(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined || session.state !== 'RUNNING') {
      return
    }

    log.info(`[agent-runtime:${sessionId}] Session timed out`)
    this.cancel(sessionId)
  }

  /**
   * Cleanup on app shutdown.
   */
  destroy(): void {
    log.info('[agent-runtime] Destroying all sessions')
    for (const session of this.sessions.values()) {
      this.clearSessionTimeout(session)
      session.abortController.abort()
    }
    this.sessions.clear()
  }

  private hasRunbookTools(): boolean {
    return this.runbookGateway !== undefined
  }

  private getRunbookGateway(): AgentRuntimeRunbookGateway {
    if (this.runbookGateway === undefined) {
      throw new Error('Runbook gateway is not configured')
    }

    return this.runbookGateway
  }

  private async runExplicitlyMentionedRunbook(session: AgentSession): Promise<DirectRunbookExecutionResult | null> {
    if (!this.hasRunbookTools()) {
      return null
    }

    const latestUserMessageIndex = findLatestUserMessageIndex(session.messages)
    if (latestUserMessageIndex < 0) {
      return null
    }

    const latestUserMessage = session.messages[latestUserMessageIndex]
    const userText = readChatMessageText(latestUserMessage.content)
    const normalizedUserText = normalizeRunbookMention(userText)
    if (normalizedUserText.length === 0) {
      return null
    }
    const matches = (await this.listExecutableRunbooks()).filter((runbook) => {
      const normalizedTitle = normalizeRunbookMention(runbook.title)
      return normalizedTitle.length > 0 && normalizedUserText.includes(normalizedTitle)
    })

    if (matches.length !== 1) {
      return null
    }

    const [runbook] = matches
    const parameterValues = resolveDirectRunbookParameterValues(runbook, userText)
    if (parameterValues === null) {
      return null
    }

    const normalizedRunbookTitle = normalizeRunbookMention(runbook.title)
    if (
      !hasExplicitRunbookExecutionIntent(userText, normalizedUserText) &&
      !asksForNamedRunbookOutput(userText, normalizedUserText, normalizedRunbookTitle)
    ) {
      return null
    }

    log.info(`[agent-runtime:${session.id}] Running explicitly mentioned runbook through the app runtime: ${runbook.title}`)

    const result = await this.executeRunbook(session, {
      runbookId: runbook.id,
      runbookTitle: runbook.title,
      parameterValues,
    })
    const rawOutput = result.output?.trim() ?? ''
    const modelContext = this.buildDirectRunbookExecutionConversationContent(runbook.title, rawOutput, result)

    return {
      toolCall: {
        id: `direct-execute-runbook-${randomUUID()}`,
        name: 'execute_runbook',
        args: {
          runbookId: runbook.id,
          runbookTitle: runbook.title,
        },
      },
      result,
      modelContext,
      visibleResult: this.buildVisibleRunbookExecutionResult(result),
    }
  }

  private findActiveIncidentSession(incidentThreadId: string): AgentSession | null {
    return (
      [...this.sessions.values()]
        .filter(
          (session) =>
            session.incidentThreadId === incidentThreadId && session.state === 'RUNNING',
        )
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ??
      null
    )
  }

  private findMostRecentIncidentSession(incidentThreadId: string): AgentSession | null {
    return (
      [...this.sessions.values()]
        .filter((session) => session.incidentThreadId === incidentThreadId)
        .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ??
      null
    )
  }

  private dedupeToolCalls(session: AgentSession, toolCalls: ToolCall[]): ToolCall[] {
    const seenIds = new Set<string>()
    const deduped: ToolCall[] = []

    for (const toolCall of toolCalls) {
      if (toolCall.id.length === 0) {
        deduped.push(toolCall)
        continue
      }

      if (seenIds.has(toolCall.id)) {
        log.warn(
          `[agent-runtime:${session.id}] Skipping duplicate tool call id in same response: ${toolCall.id}`,
        )
        continue
      }

      seenIds.add(toolCall.id)
      deduped.push(toolCall)
    }

    return deduped
  }

  private prepareSessionForContinuation(session: AgentSession): AgentSession {
    if (session.state !== 'FAILED' && session.state !== 'CANCELLED' && session.state !== 'COMPLETED') {
      throw new Error(`Session ${session.id} is not resumable (state: ${session.state})`)
    }

    session.state = 'RUNNING'
    session.currentToolCallId = null
    session.expiresAt = Date.now() + DEFAULT_AGENT_SESSION_TIMEOUT_MS
    if (session.abortController.signal.aborted) {
      session.abortController = new AbortController()
    }
    session.snapshot = setAgentThreadRuntimeState(session.snapshot, 'RUNNING')
    return session
  }

  private isDynamicToolName(toolName: string): boolean {
    return isHostToolName(toolName)
  }

  private getDynamicToolDefinitions(): Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }> {
    if (!this.hasRunbookTools()) return []

    return getHostTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.argsSchema as never),
    }))
  }

  private async executeDynamicToolCall(session: AgentSession, toolCall: ToolCall): Promise<ToolResult | null> {
    if (!this.hasRunbookTools()) return null
    if (toolCall.name === 'execute_runbook') {
      this.sendEvent(session.id, {
        type: 'activity',
        timestamp: new Date().toISOString(),
        phase: 'running_runbook',
      })
    }
    const result = await executeHostTool(
      this.createHostToolContext(session),
      toolCall.name,
      toolCall.args,
    )
    if (result !== null) {
      this.recordRunbookToolOutcome(session, toolCall.name, result)
    }
    return result
  }

  private async executeRunbook(session: AgentSession, input: ExecuteRunbookInput): Promise<ToolResult> {
    this.sendEvent(session.id, {
      type: 'activity',
      timestamp: new Date().toISOString(),
      phase: 'running_runbook',
    })
    const result = await executeHostTool(this.createHostToolContext(session), 'execute_runbook', input)
    if (result === null) {
      return { error: 'The execute_runbook host tool is not registered' }
    }
    return result
  }

  private createHostToolContext(
    session: AgentSession,
    options: { observeEvents?: boolean } = {},
  ): HostToolContext {
    return {
      gateway: this.getRunbookGateway(),
      session: session as AgentSessionRef,
      buildRequestKey: (sessionRef, runbook, parameterValues) =>
        buildGatewayRunbookRequestKey(sessionRef as AgentSession, runbook, parameterValues),
      resolveParameterValues: (sessionRef, runbook, input) =>
        this.resolveRunbookParameterValues(sessionRef as AgentSession, runbook, input),
      summarizeExecution: summarizeRunbookExecutionForToolOutput,
      rememberExecution: (sessionRef, execution) =>
        this.rememberJournalTimeWindowParameters(sessionRef as AgentSession, execution),
      listAuthorableRunbooks: () => this.getRunbookStore().list(),
      pluginRuntime: this.pluginRuntime,
      ...(options.observeEvents
        ? { onToolEvent: (event: HostToolEvent) => this.observeHostToolEvent(session, event) }
        : {}),
    }
  }

  private observeHostToolEvent(session: AgentSession, event: HostToolEvent): void {
    const observedCalls = session.currentTurnHostToolCalls ?? new Map<string, ObservedHostToolCall>()
    session.currentTurnHostToolCalls = observedCalls
    const toolCall: ToolCall = {
      id: event.toolCallId,
      name: event.toolName,
      args: event.args,
    }

    if (event.type === 'started') {
      observedCalls.set(event.toolCallId, { toolCall })
      session.currentToolCallId = event.toolCallId
      if (event.toolName === 'execute_runbook') {
        this.sendEvent(session.id, {
          type: 'activity',
          timestamp: event.timestamp,
          phase: 'running_runbook',
        })
      }
      this.sendEvent(session.id, {
        type: 'tool_start',
        timestamp: event.timestamp,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        input: event.args,
      })
      return
    }

    const observedCall = observedCalls.get(event.toolCallId) ?? { toolCall }
    const modelContext = this.buildToolConversationContent(observedCall.toolCall, event.result)
    observedCalls.set(event.toolCallId, {
      ...observedCall,
      result: event.result,
      modelContext,
    })
    this.recordRunbookToolOutcome(session, event.toolName, event.result)
    if (session.currentToolCallId === event.toolCallId) {
      session.currentToolCallId = null
    }
    this.sendEvent(session.id, {
      type: 'tool_end',
      timestamp: event.timestamp,
      toolCallId: event.toolCallId,
      state: getToolEndState(event.result),
      output: event.result.output,
      error: event.result.error,
      modelContext,
    })

    const visibleResult = this.buildVisibleRunbookToolResult({
      toolCall: observedCall.toolCall,
      result: event.result,
      modelContext,
    })
    if (visibleResult === null || event.toolName === 'list_runbooks') {
      return
    }
    const visibleExecutionIds = session.currentTurnVisibleRunbookExecutionIds ?? new Set<string>()
    session.currentTurnVisibleRunbookExecutionIds = visibleExecutionIds
    if (visibleResult.executionId !== undefined && visibleExecutionIds.has(visibleResult.executionId)) {
      return
    }
    if (visibleResult.executionId !== undefined) {
      visibleExecutionIds.add(visibleResult.executionId)
    }
    this.sendEvent(session.id, {
      type: 'assistant_delta',
      timestamp: event.timestamp,
      delta: visibleResult.text,
      kind: 'command_output',
    })
  }

  private recordRunbookToolOutcome(
    session: AgentSession,
    toolName: string,
    result: ToolResult,
  ): void {
    if (toolName === 'list_runbooks' && result.error === undefined) {
      const payload = this.safeParseObject(result.output ?? '')
      const runbooks = readRecordArrayProperty(payload, 'runbooks')
      if (runbooks.some((runbook) => readRunbookParameterSummaries(runbook).length > 0)) {
        session.hasRunbookParameters = true
      }
    }
    if (toolName === 'execute_runbook' && (session.currentTurnStartedRunbookExecutionIds?.size ?? 0) > 1) {
      session.hasMultipleRunbooksInPlay = true
    }
  }

  private takeCompletedHostToolCalls(session: AgentSession): CompletedToolResult[] {
    const observedCalls = session.currentTurnHostToolCalls
    if (observedCalls === undefined) return []

    const completedCalls = [...observedCalls.values()].flatMap((entry) => {
      if (entry.result === undefined || entry.modelContext === undefined) return []
      return [{
        toolCall: entry.toolCall,
        result: entry.result,
        modelContext: entry.modelContext,
      }]
    })
    session.currentTurnHostToolCalls = new Map()
    return completedCalls
  }

  private async listExecutableRunbooks(): Promise<RunbookRecord[]> {
    return this.getRunbookGateway().listExecutable()
  }

  private getRunbookStore(): AgentRuntimeRunbookStore {
    if (this.runbookStore === undefined) throw new Error('Runbook authoring is not configured')
    return this.runbookStore
  }

  private resolveRunbookAuthoringSessions(input: { sessionId?: string; incidentThreadId?: string }): AgentSession[] {
    if (input.sessionId !== undefined && input.sessionId.length > 0) {
      const session = this.sessions.get(input.sessionId)
      if (session === undefined) throw new Error(`Session not found: ${input.sessionId}`)
      return [session]
    }
    if (input.incidentThreadId !== undefined && input.incidentThreadId.length > 0) return [...this.sessions.values()].filter((session) => session.incidentThreadId === input.incidentThreadId)
    throw new Error('Runbook authoring proposal lookup requires sessionId or incidentThreadId.')
  }

  private resolveRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string }): { session: AgentSession; proposal: RunbookAuthoringProposal; proposalIndex: number } {
    const matches = this.resolveRunbookAuthoringSessions(input).flatMap((session) => {
      const proposalIndex = session.runbookAuthoringProposals.findIndex((proposal) => proposal.id === input.proposalId)
      return proposalIndex === -1 ? [] : [{ session, proposal: session.runbookAuthoringProposals[proposalIndex], proposalIndex }]
    })
    if (matches.length === 0) throw new Error(`Runbook authoring proposal not found: ${input.proposalId}`)
    if (matches.length > 1) throw new Error(`Multiple runbook authoring proposals match ${input.proposalId}. Use sessionId.`)
    return matches[0]
  }

  private async resolveCurrentRunbookForAuthoringApproval(proposal: Extract<RunbookAuthoringProposal, { kind: 'edit_existing_runbook' }>): Promise<RunbookRecord> {
    const runbook = (await this.getRunbookStore().list()).find((item) => item.id === proposal.targetRunbookId)
    if (runbook === undefined) throw new Error(`Runbook not found for authoring approval: ${proposal.targetRunbookId}`)
    return runbook
  }

  private async persistApprovedRunbookAuthoringProposal(runbook: RunbookRecord, proposal: RunbookAuthoringProposal): Promise<RunbookRecord> {
    const inFlight = this.authoringPersistence.get(proposal.id)
    if (inFlight !== undefined) return inFlight

    const persistence = this.persistApprovedRunbookAuthoringProposalOnce(runbook, proposal)
    this.authoringPersistence.set(proposal.id, persistence)
    try {
      return await persistence
    } finally {
      this.authoringPersistence.delete(proposal.id)
    }
  }

  private async persistApprovedRunbookAuthoringProposalOnce(runbook: RunbookRecord, proposal: RunbookAuthoringProposal): Promise<RunbookRecord> {
    const store = this.getRunbookStore()
    const persistedRunbook = remapRunbookAuthoringPersistenceIds(runbook)
    if (proposal.kind === 'create_new_runbook') {
      return this.createApprovedRunbookAuthoringProposal(store, persistedRunbook)
    }

    return this.updateApprovedRunbookAuthoringProposal(store, persistedRunbook, proposal)
  }

  private async createApprovedRunbookAuthoringProposal(store: AgentRuntimeRunbookStore, runbook: RunbookRecord): Promise<RunbookRecord> {
    const saved = await this.createApprovedRunbookShell(store, runbook)
    try {
      const updated = runbook.actions.length > 0
        ? await store.updateActions({ runbookId: saved.id, actions: runbook.actions })
        : saved
      if (updated === null) throw new Error(`Runbook authoring approval did not save runbook: ${runbook.id}`)
      this.verifyApprovedRunbookPersistence(runbook, updated)
      return updated
    } catch (error) {
      await store.purge({ id: saved.id }).catch((cleanupError: unknown) => {
        log.error('[agent-runtime] Failed to purge runbook shell after authoring approval persistence failed', {
          runbookId: saved.id,
          error: getErrorMessage(cleanupError),
        })
      })
      throw error
    }
  }

  private async createApprovedRunbookShell(store: AgentRuntimeRunbookStore, runbook: RunbookRecord): Promise<RunbookRecord> {
    const input = { id: runbook.id, title: runbook.title, description: runbook.description, idleTimeout: runbook.idleTimeout }
    try {
      return await store.create(input)
    } catch (error) {
      const existing = await store.getIncludingDeleted(runbook.id)
      if (existing !== null && existing.deletedAt === null && hasCompleteAuthoringPersistence(runbook, existing.runbook)) {
        return existing.runbook
      }
      if (existing === null) throw error
      await store.purge({ id: runbook.id })
      return store.create(input)
    }
  }

  private async updateApprovedRunbookAuthoringProposal(
    store: AgentRuntimeRunbookStore,
    runbook: RunbookRecord,
    proposal: Extract<RunbookAuthoringProposal, { kind: 'edit_existing_runbook' }>,
  ): Promise<RunbookRecord> {
    const latest = await this.resolveCurrentRunbookForAuthoringApproval(proposal)
    if (getRunbookAuthoringRevisionHash(latest) !== proposal.targetRevisionHash) throw new Error('This runbook changed after the authoring proposal was created. Ask the agent to revise the proposal against the latest runbook before approving it.')
    const metadata = await store.updateMeta({ id: runbook.id, title: runbook.title, description: runbook.description, idleTimeout: runbook.idleTimeout })
    const saved = await store.updateActions({ runbookId: runbook.id, actions: runbook.actions }) ?? metadata
    if (saved === null) throw new Error(`Runbook authoring approval did not save runbook: ${runbook.id}`)
    this.verifyApprovedRunbookPersistence(runbook, saved)
    return saved
  }

  private verifyApprovedRunbookPersistence(expected: RunbookRecord, saved: RunbookRecord): void {
    if (saved.title === expected.title && saved.actions.length === expected.actions.length) return
    log.error('[agent-runtime] Runbook authoring approval saved an inconsistent runbook', {
      runbookId: expected.id,
      expectedTitle: expected.title,
      savedTitle: saved.title,
      expectedActionCount: expected.actions.length,
      savedActionCount: saved.actions.length,
    })
    throw new Error(`Runbook authoring approval saved an inconsistent runbook: ${expected.id}`)
  }

  private appendRunbookAuthoringDecisionNote(
    session: AgentSession,
    input: {
      proposal: RunbookAuthoringProposal
      decision: 'approved' | 'rejected' | 'revision_requested'
      savedRunbook?: RunbookRecord
      reason?: string
      requestedEdit?: string
    },
  ): void {
    const details = [
      `proposalId=${input.proposal.id}`,
      `decision=${input.decision}`,
    ]
    if (input.savedRunbook !== undefined) {
      details.push(`savedRunbookId=${input.savedRunbook.id}`, `savedRunbookTitle=${input.savedRunbook.title}`)
    }
    if (input.reason !== undefined && input.reason.length > 0) details.push(`reason=${input.reason}`)
    if (input.requestedEdit !== undefined && input.requestedEdit.length > 0) details.push(`requestedEdit=${input.requestedEdit}`)

    const executionInstruction = input.decision === 'approved'
      ? ' Use savedRunbookId with execute_runbook, or call list_runbooks to obtain a current id.'
      : ''
    session.messages.push({
      role: 'system',
      content: `Internal runbook authoring outcome: ${details.join('; ')}.${executionInstruction}`,
    })
  }

  private summarizeRunbookAuthoringProposal(proposal: RunbookAuthoringProposal): RunbookAuthoringProposalReview {
    return { status: proposal.status, approvalRequired: true, saved: proposal.status === 'approved', proposalId: proposal.id, kind: proposal.kind, incidentThreadId: proposal.incidentThreadId, targetRunbookId: proposal.kind === 'edit_existing_runbook' ? proposal.targetRunbookId : undefined, targetRevisionNumber: proposal.kind === 'edit_existing_runbook' ? proposal.targetRevisionNumber : undefined, proposedRunbook: { id: proposal.proposedRunbook.id, title: proposal.proposedRunbook.title, description: proposal.proposedRunbook.description, revisionNumber: proposal.proposedRunbook.revisionNumber, actionCount: proposal.proposedRunbook.actions.length, actions: proposal.proposedRunbook.actions.map((action) => ({ id: action.id, type: action.type, title: action.title })) }, validation: proposal.validation, operationDiffs: proposal.operationDiffs, nextStep: 'Show this proposal to the operator. The draft runbook id is provisional and the saved id may differ; execute only with an id from list_runbooks or the approval notification.' }
  }

  private shouldDeferRunbookLookupInBatch(
    session: AgentSession,
    toolCall: ToolCall,
    hasRunbookStartInBatch: boolean,
    runbookStartCompletedInBatch: boolean,
  ): boolean {
    if (!hasRunbookStartInBatch || toolCall.name !== 'get_runbook_execution') {
      return false
    }

    const normalizedArgs = normalizeToolArgs(toolCall.name, toolCall.args)
    if (normalizedArgs.waitForCompletion === true) {
      return false
    }
    let executionId = ''
    if (typeof normalizedArgs.executionId === 'string') {
      executionId = normalizedArgs.executionId.trim()
    }
    if (executionId.length > 0) {
      return false
    }

    if (!runbookStartCompletedInBatch) {
      return true
    }

    return false
  }

  private buildDeferredRunbookLookupResult(toolCall: ToolCall): ToolResult {
    const normalizedArgs = normalizeToolArgs(toolCall.name, toolCall.args)
    const payload: Record<string, unknown> = {
      status: 'deferred',
      runbookTitle: 'Runbook execution lookup',
      lookupDeferred: true,
      reason:
        'This assistant response also started runbooks. Wait for those execute_runbook results, then inspect the real execution IDs in the next iteration.',
    }
    if (typeof normalizedArgs.executionId === 'string' && normalizedArgs.executionId.length > 0) {
      payload.requestedExecutionId = normalizedArgs.executionId
    }

    return {
      output: JSON.stringify(
        payload,
        null,
        2,
      ),
    }
  }

  private buildRunbookTriggerContext(session: AgentSession): RunbookTriggerContext | undefined {
    if (session.incidentThreadId === undefined || session.incidentThreadId.length === 0) {
      return undefined
    }

    return {
      entrypoint: 'incident_workspace',
      incidentThreadId: session.incidentThreadId,
    }
  }

  private buildDeferredRunbookResponse(
    executedToolResults: Array<{ toolCall: ToolCall; result: ToolResult }>,
  ): string | null {
    for (const entry of executedToolResults) {
      if (
        entry.result.error !== undefined ||
        entry.result.output === undefined ||
        entry.result.output.length === 0
      ) {
        continue
      }

      if (entry.toolCall.name === 'get_runbook_execution') {
        const payload = this.safeParseObject(entry.result.output)
        const statusValue = readStringProperty(payload, 'status')
        let status = ''
        if (statusValue !== null) {
          status = statusValue.toLowerCase()
        }
        if (
          payload?.repeatBlocked === true &&
          status !== 'completed' &&
          status !== 'failed' &&
          status !== 'cancelled'
        ) {
          const runbookTitle = readFirstStringProperty([payload], 'runbookTitle', 'The runbook')
          return `${runbookTitle} was already checked in this turn and the local executor will not reveal new details until something changes. I’m stopping here to avoid looping. Ask me again later for a fresh status check.`
        }
        if (status === 'running' || status === 'pending') {
          const runbookTitle = readFirstStringProperty([payload], 'runbookTitle', 'The runbook')
          return `${runbookTitle} is still running after the completion-aware lookup. I’m reporting its latest state without making another lookup in this response.`
        }
      }
    }

    return null
  }

  private hasVisibleRunbookToolResult(executedToolResults: CompletedToolResult[] | null | undefined): boolean {
    return executedToolResults?.some((entry) => this.buildVisibleRunbookToolResult(entry) != null) ?? false
  }

  private buildVisibleRunbookFallbackResponse(
    executedToolResults: CompletedToolResult[] | null | undefined,
    existingContent: string,
  ): string {
    const visibleResults =
      executedToolResults
        ?.filter((entry) => entry.toolCall.name === 'list_runbooks' || entry.toolCall.name === 'execute_runbook')
        ?.map((entry) => this.buildVisibleRunbookToolResult(entry))
        .filter((entry): entry is VisibleRunbookToolResult => entry !== null) ?? []
    if (visibleResults.length === 0) {
      return ''
    }

    const existingNormalized = existingContent.trim()
    const existingLowercase = existingNormalized.toLocaleLowerCase()
    const blocks = visibleResults
      .map((entry) => entry.text.trim())
      .filter((text, index) => {
        if (text.length === 0 || existingNormalized.includes(text)) {
          return false
        }

        const dedupeText = visibleResults[index]?.dedupeText
        if (dedupeText !== undefined && dedupeText.length > 0 && existingNormalized.includes(dedupeText)) {
          return false
        }

        const dedupeTokens = visibleResults[index]?.dedupeTokens ?? []
        if (
          dedupeTokens.length > 0 &&
          dedupeTokens.every((token) => existingLowercase.includes(token.toLocaleLowerCase()))
        ) {
          return false
        }

        return true
      })
    if (blocks.length === 0) {
      return ''
    }

    return joinNonEmptyBlocks('Completed runbook output:', ...blocks)
  }

  private buildVisibleRunbookToolResult(entry: CompletedToolResult): VisibleRunbookToolResult | null {
    if (entry.toolCall.name === 'list_runbooks') {
      return this.buildVisibleRunbookListResult(entry.result)
    }

    if (entry.toolCall.name !== 'execute_runbook' && entry.toolCall.name !== 'get_runbook_execution') {
      return null
    }

    return this.buildVisibleRunbookExecutionResult(entry.result, entry.toolCall.name)
  }

  private buildVisibleRunbookListResult(result: ToolResult): VisibleRunbookToolResult | null {
    if (result.error !== undefined && result.error.length > 0) {
      return null
    }

    if (result.output === undefined || result.output.length === 0) {
      return null
    }

    const payload = this.safeParseObject(result.output)
    if (payload === null) {
      return null
    }

    const runbooks = readRecordArrayProperty(payload, 'runbooks')
    if (runbooks.length === 0) {
      return { text: 'No runnable runbooks are currently available.' }
    }

    const lines = ['Available runbooks:']
    const dedupeTokens: string[] = []
    for (const runbook of runbooks) {
      const entry = formatVisibleRunbookListEntry(runbook)
      dedupeTokens.push(entry.title)
      lines.push(...entry.lines)
    }

    return { text: lines.join('\n'), dedupeTokens }
  }

  private buildVisibleRunbookExecutionResult(
    result: ToolResult,
    toolName: 'execute_runbook' | 'get_runbook_execution' = 'execute_runbook',
  ): VisibleRunbookToolResult | null {
    const data = this.readVisibleRunbookExecutionData(result, toolName)
    return data === null ? null : this.formatVisibleRunbookExecutionResult(data)
  }

  private readVisibleRunbookExecutionData(
    result: ToolResult,
    toolName: 'execute_runbook' | 'get_runbook_execution',
  ): VisibleRunbookExecutionData | null {
    if (result.error !== undefined && result.error.length > 0) {
      return null
    }

    if (result.output === undefined || result.output.length === 0) {
      return null
    }

    const payload = this.safeParseObject(result.output)
    if (payload === null || payload.lookupDeferred === true) {
      return null
    }
    if (payload.repeatBlocked === true) {
      return null
    }

    const executionSummary = readExecutionSummaryRecord(toolName, payload)
    const runbookTitle = readFirstStringProperty([payload, executionSummary], 'runbookTitle', 'Runbook')
    const status = readFirstStringProperty([payload, executionSummary], 'status', 'completed')
    const executionId = readFirstStringProperty([payload, executionSummary], 'executionId', '')
    const normalizedStatus = status.toLowerCase()
    if (normalizedStatus === 'pending' || normalizedStatus === 'running' || normalizedStatus === 'started') {
      return null
    }

    const latestStep = readRecordProperty(executionSummary, 'latestStep')
    const output = this.readVisibleRunbookExecutionOutput(executionSummary)
    return {
      runbookTitle,
      status,
      executionId,
      latestStep,
      ...output,
      latestStepError: readNonEmptyTrimmedStringProperty(latestStep, 'errorExcerpt'),
      completedStepCount: readNumberProperty(executionSummary, 'completedStepCount'),
      stepCount: readNumberProperty(executionSummary, 'stepCount'),
    }
  }

  private readVisibleRunbookExecutionOutput(executionSummary: Record<string, unknown> | null): Pick<VisibleRunbookExecutionData, 'finalOutput' | 'finalOutputTruncated' | 'finalOutputLength' | 'windowCount'> {
    const finalStructuredOutput = readRecordProperty(executionSummary, 'finalStructuredOutput')
    const structuredIssues = readRecordArrayProperty(finalStructuredOutput, 'issues')
    const finalOutput = structuredIssues.length > 0
      ? [`Top ${String(structuredIssues.length)} issues:`, ...formatStructuredIssuePreview(structuredIssues)].join('\n')
      : readNonEmptyTrimmedStringProperty(executionSummary, 'finalOutputMarkdownExcerpt')
        ?? readNonEmptyTrimmedStringProperty(executionSummary, 'finalOutputExcerpt')
    return {
      finalOutput,
      finalOutputTruncated: executionSummary?.finalOutputMarkdownTruncated === true || executionSummary?.finalOutputTruncated === true,
      finalOutputLength: readNumberProperty(executionSummary, 'finalOutputMarkdownLength') ?? readNumberProperty(executionSummary, 'finalOutputLength'),
      windowCount: readNumberProperty(executionSummary, 'actionableJournalTimeWindowCount')
        ?? readRecordArrayProperty(executionSummary, 'actionableJournalTimeWindows').length,
    }
  }

  private formatVisibleRunbookExecutionResult(data: VisibleRunbookExecutionData): VisibleRunbookToolResult {
    const lines = [`Runbook result: ${data.runbookTitle}`, `Status: ${data.status}`]
    if (data.completedStepCount !== null && data.stepCount !== null) {
      lines.push(`Steps: ${String(data.completedStepCount)}/${String(data.stepCount)} completed`)
    }

    if (data.latestStep !== null) {
      const latestStepTitle = readFirstStringProperty([data.latestStep], 'title', 'Unknown')
      const latestStepStatus = readFirstStringProperty([data.latestStep], 'status', 'unknown')
      lines.push(`Latest step: ${latestStepTitle} (${latestStepStatus})`)
    }

    if (data.latestStepError !== null) {
      lines.push(`Error: ${data.latestStepError}`)
    }

    if (data.finalOutput !== null) {
      lines.push('', data.finalOutput)
    }

    if (data.finalOutputTruncated && data.finalOutputLength !== null) {
      lines.push(`\nOutput preview truncated from ${String(data.finalOutputLength)} characters. Open Runbook Results for the full output.`)
    }

    if (data.windowCount > 0) {
      lines.push('', `Journal windows available: ${String(data.windowCount)}`)
    }

    lines.push('', '')

    const visibleResult: VisibleRunbookToolResult = {
      text: lines.join('\n'),
    }
    if (data.finalOutput !== null) {
      visibleResult.dedupeText = data.finalOutput
    }
    if (data.executionId.length > 0) {
      visibleResult.executionId = data.executionId
    }

    return visibleResult
  }

  private safeParseObject(value: string): Record<string, unknown> | null {
    try {
      return readUnknownRecord(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }

  private buildToolConversationContent(toolCall: ToolCall, result: ToolResult): string {
    if (result.error !== undefined && result.error.length > 0) {
      return [
        `Tool "${toolCall.name}" failed.`,
        `Error: ${result.error}`,
        'Do not assume the tool succeeded. Decide whether to try a different tool or explain the failure.',
      ].join('\n')
    }

    let rawOutput = 'Tool execution completed.'
    if (result.output !== undefined && result.output.trim().length > 0) {
      rawOutput = result.output.trim()
    }

    if (toolCall.name === 'list_runbooks') {
      return this.buildRunbookListConversationContent(rawOutput)
    }

    if (toolCall.name === 'execute_runbook' || toolCall.name === 'get_runbook_execution') {
      return this.buildRunbookExecutionConversationContent(toolCall.name, rawOutput)
    }

    return [
      `Tool "${toolCall.name}" completed.`,
      rawOutput,
      'Summarize the meaningful findings for the user. Do not quote internal transcript labels unless asked.',
    ].join('\n')
  }

  private buildRunbookListConversationContent(rawOutput: string): string {
    const payload = this.safeParseObject(rawOutput)
    const runbooks = readRecordArrayProperty(payload, 'runbooks')
    if (runbooks.length === 0) {
      return rawOutput
    }

    const lines = ['Internal runbook list:']
    for (const runbook of runbooks) {
      this.appendRunbookListSummary(lines, runbook)
    }
    lines.push('Choose only from the exact runbook titles above. Do not invent runbook titles or IDs.')
    lines.push('Summarize the available runbooks for the user in clean Markdown.')

    return lines.join('\n')
  }

  private appendRunbookListSummary(lines: string[], runbook: Record<string, unknown>): void {
    lines.push(`- ${readFirstStringProperty([runbook], 'title', 'Untitled runbook')}`)
    const description = readNonEmptyTrimmedStringProperty(runbook, 'description')
    if (description !== null) {
      lines.push(`  Description: ${description}`)
    }

    const parameters = readRunbookParameterSummaries(runbook)
    const actions = readRecordArrayProperty(runbook, 'actions')
    if (actions.length > 0) {
      lines.push('  Actions:')
      for (const action of actions) {
        const id = readFirstStringProperty([action], 'id', 'unknown-action')
        const type = readFirstStringProperty([action], 'type', 'unknown')
        const title = readFirstStringProperty([action], 'title', 'Untitled action')
        lines.push(`  - ${id} (${type}: ${title})`)
      }
    }
    if (parameters.length === 0) {
      lines.push('  Parameters: none.')
      return
    }

    lines.push('  Parameters:')
    lines.push(...formatRunbookParameterSummary(parameters).map((parameter) => `  ${parameter}`))
  }

  private buildDirectRunbookExecutionConversationContent(
    runbookTitle: string,
    rawOutput: string,
    result: ToolResult,
  ): string {
    if (result.error !== undefined && result.error.length > 0) {
      return [
        `BitSentry directly tried to run the "${runbookTitle}" runbook because the user's message clearly named that exact runbook.`,
        `The app-owned runbook runtime failed before returning a successful execution result.`,
        `Error: ${result.error}`,
        'Explain the failure to the user. Do not claim the model called execute_runbook.',
      ].join('\n')
    }

    const executionContext = this.buildRunbookExecutionConversationContent('execute_runbook', rawOutput)
    return [
      `BitSentry directly ran the "${runbookTitle}" runbook because the user's message clearly named that exact runbook.`,
      'This was app-owned runbook runtime behavior, not an AI-requested tool call.',
      executionContext,
      'Summarize the runbook result for the user in clean Markdown.',
    ].join('\n')
  }

  private buildRunbookExecutionConversationContent(toolName: string, rawOutput: string): string {
    const payload = this.safeParseObject(rawOutput)
    const executionSummary = readExecutionSummaryRecord(toolName, payload)
    const runbookTitle = readFirstStringProperty([payload, executionSummary], 'runbookTitle', 'the runbook')
    const status = readFirstStringProperty([payload, executionSummary], 'status', 'unknown')
    const lookupDeferred = readBooleanProperty(payload, 'lookupDeferred')
    const repeatBlocked = readBooleanProperty(payload, 'repeatBlocked') || readBooleanProperty(executionSummary, 'repeatBlocked')
    const derivedJournalTimeWindow = readRunbookTimeWindow(executionSummary?.derivedJournalTimeWindow) ?? undefined
    const aggregateActionableJournalTimeWindow = readRunbookTimeWindow(
      executionSummary?.aggregateActionableJournalTimeWindow,
    ) ?? undefined
    const actionableJournalTimeWindows = readRecordArrayProperty(executionSummary, 'actionableJournalTimeWindows')
      .map(readActionableJournalTimeWindow)
      .filter((window): window is ActionableJournalTimeWindow => window !== null)
    const normalizedStatus = status.toLowerCase()
    const shouldInspectStartedRunbook =
      toolName === 'execute_runbook' &&
      !repeatBlocked &&
      (normalizedStatus === 'started' || normalizedStatus === 'running')

    const lines = [
      'Internal runbook execution update:',
      `- Runbook: ${runbookTitle}`,
      `- Status: ${status}`,
    ]

    this.appendRunbookExecutionStepLines(lines, executionSummary)
    this.appendRunbookExecutionOutputLines(lines, executionSummary)
    this.appendRunbookExecutionWindowLines(lines, {
      executionSummary,
      derivedJournalTimeWindow,
      aggregateActionableJournalTimeWindow,
      actionableJournalTimeWindows,
    })
    this.appendRunbookExecutionControlLines(lines, {
      payload,
      status: normalizedStatus,
      lookupDeferred,
      repeatBlocked,
      shouldInspectStartedRunbook,
    })
    lines.push('Summarize the meaningful status for the user. Do not paste internal status blocks or raw JSON.')

    return lines.join('\n')
  }

  private appendRunbookExecutionStepLines(lines: string[], executionSummary: Record<string, unknown> | null): void {
    const latestStep = readRecordProperty(executionSummary, 'latestStep')
    if (latestStep !== null) {
      const title = readFirstStringProperty([latestStep], 'title', 'Unknown')
      const status = readFirstStringProperty([latestStep], 'status', 'unknown')
      lines.push(`- Latest step: ${title} (${status})`)
    }

    const steps = readRecordArrayProperty(executionSummary, 'steps')
    if (steps.length === 0) {
      return
    }

    lines.push('- Steps:')
    for (const step of steps) {
      let title = readStringProperty(step, 'title')
      if (title === null) {
        const order = readNumberProperty(step, 'order')
        title = 'Step ?'
        if (order !== null) {
          title = `Step ${String(order)}`
        }
      }
      const status = readFirstStringProperty([step], 'status', 'unknown')
      lines.push(`  - ${title}: ${status}`)
    }
  }

  private appendRunbookExecutionOutputLines(lines: string[], executionSummary: Record<string, unknown> | null): void {
    const finalStructuredOutput = readRecordProperty(executionSummary, 'finalStructuredOutput')
    const structuredIssues = readRecordArrayProperty(finalStructuredOutput, 'issues')
    if (structuredIssues.length > 0) {
      lines.push(`- Structured issue preview (top ${String(structuredIssues.length)}):`)
      lines.push(...formatStructuredIssuePreview(structuredIssues).map((issue) => `  ${issue}`))
      const issueCount = readNumberProperty(finalStructuredOutput, 'issueCount')
      if (finalStructuredOutput?.issuesTruncated === true && issueCount !== null) {
        lines.push(`- ${String(issueCount - structuredIssues.length)} more issues remain in Runbook Results.`)
      }
    }

    const finalOutputExcerpt = readStringProperty(executionSummary, 'finalOutputExcerpt')
    if (finalOutputExcerpt !== null && structuredIssues.length === 0) {
      lines.push(`- Final output excerpt: ${finalOutputExcerpt}`)
    }

    const finalOutputLength = readNumberProperty(executionSummary, 'finalOutputLength')
    if (executionSummary?.finalOutputTruncated === true && finalOutputLength !== null) {
      lines.push(`- The model-visible final output excerpt was truncated from ${String(finalOutputLength)} characters.`)
    }
  }

  private appendRunbookExecutionWindowLines(
    lines: string[],
    input: {
      executionSummary: Record<string, unknown> | null
      derivedJournalTimeWindow: RunbookParameterValues | undefined
      aggregateActionableJournalTimeWindow: RunbookParameterValues | undefined
      actionableJournalTimeWindows: ActionableJournalTimeWindow[]
    },
  ): void {
    if (input.derivedJournalTimeWindow !== undefined && input.actionableJournalTimeWindows.length === 0) {
      lines.push(
        `- Derived journalctl time window: since="${input.derivedJournalTimeWindow.since}", until="${input.derivedJournalTimeWindow.until}".`,
        '- For backend log cross-validation, pass this window as execute_runbook.parameterValues to the backend log runbook instead of asking the user for timestamps.',
      )
      return
    }

    if (input.actionableJournalTimeWindows.length === 0) {
      return
    }

    lines.push('- Actionable journalctl windows from the runbook output:')
    if (input.aggregateActionableJournalTimeWindow !== undefined) {
      lines.push(
        `  - Combined window for one backend log runbook call: since="${input.aggregateActionableJournalTimeWindow.since}", until="${input.aggregateActionableJournalTimeWindow.until}"`,
        '- Prefer the combined window above for cross-validation so the backend log runbook runs once, not once per issue row.',
      )
    }

    input.actionableJournalTimeWindows.forEach((window, index) => {
      const labelParts: string[] = []
      if (window.issue !== undefined) {
        labelParts.push(window.issue)
      }
      if (window.timestamp !== undefined) {
        labelParts.push(`timestamp=${window.timestamp}`)
      }

      let label = `window ${String(index + 1)}: `
      if (labelParts.length > 0) {
        label = `${labelParts.join(', ')}: `
      }
      lines.push(`  - ${label}since="${window.since}", until="${window.until}"`)
    })

    const windowCount = readNumberProperty(input.executionSummary, 'actionableJournalTimeWindowCount')
    if (input.executionSummary?.actionableJournalTimeWindowsTruncated === true && windowCount !== null) {
      const omittedCount = windowCount - input.actionableJournalTimeWindows.length
      lines.push(`  - ${String(omittedCount)} more windows were omitted from model context.`)
    }

    if (input.aggregateActionableJournalTimeWindow !== undefined) {
      lines.push(
        '- For backend log cross-validation, execute the backend log runbook once with the combined parameterValues above, then produce one consolidated matrix from the full log output.',
      )
      return
    }

    lines.push(
      '- For backend log cross-validation, execute the backend log runbook with these exact parameterValues instead of asking the user to paste the table.',
    )
  }

  private appendRunbookExecutionControlLines(
    lines: string[],
    input: {
      payload: Record<string, unknown> | null
      status: string
      lookupDeferred: boolean
      repeatBlocked: boolean
      shouldInspectStartedRunbook: boolean
    },
  ): void {
    if (input.lookupDeferred) {
      lines.push(
        '- This lookup was deferred because this same assistant response also started runbooks.',
        '- Call get_runbook_execution once with waitForCompletion: true after the execute_runbook result is available.',
      )
    }

    if (input.repeatBlocked) {
      lines.push('- This execution was already checked earlier in the same turn.')
      const reason = readStringProperty(input.payload, 'reason')
      if (reason !== null) {
        lines.push(`- Reason: ${reason}`)
      }
      if (input.status === 'completed') {
        lines.push('- Use the completed output already in context to continue the investigation instead of polling it again.')
      } else {
        lines.push('Do not make another non-wait lookup in this response. Use get_runbook_execution with waitForCompletion: true when a completion-aware result is needed.')
      }
    }

    if (input.shouldInspectStartedRunbook) {
      lines.push(
        '- Call get_runbook_execution once with waitForCompletion: true instead of finalizing from this start acknowledgement alone.',
      )
    }
  }

  private rememberJournalTimeWindowParameters(session: AgentSession, execution: RunbookExecutionRecord): void {
    const timeWindow = extractJournalTimeWindowFromExecution(execution)
    if (timeWindow === undefined) {
      session.latestJournalTimeWindowParameters = undefined
      return
    }

    session.latestJournalTimeWindowParameters = timeWindow
  }

  private runbookUsesJournalTimeWindow(runbook: RunbookRecord): boolean {
    return runbook.actions.some((action) => {
      const command = action.command?.toLowerCase() ?? ''
      if (action.type !== 'shell' || !command.includes('journalctl')) {
        return false
      }

      return (
        action.parameters?.some((parameter) => {
          const key = parameter.key.trim().toLowerCase()
          return key === 'since' || key === 'until'
        }) ?? false
      )
    })
  }

  private resolveRunbookParameterValues(
    session: AgentSession,
    runbook: RunbookRecord,
    input: ExecuteRunbookHostToolInput,
  ): Record<string, string> | undefined {
    const explicitValues = this.normalizeRunbookParameterValues(input)
    if (
      !this.runbookUsesJournalTimeWindow(runbook) ||
      session.latestJournalTimeWindowParameters === undefined
    ) {
      return explicitValues
    }

    const mergedValues = {
      ...session.latestJournalTimeWindowParameters,
      ...(explicitValues ?? {}),
    }

    for (const key of ['since', 'until']) {
      if (typeof mergedValues[key] === 'string' && mergedValues[key].trim().length === 0) {
        mergedValues[key] = session.latestJournalTimeWindowParameters[key] ?? mergedValues[key]
      }
    }

    if (Object.keys(mergedValues).length === 0) {
      return undefined
    }

    return mergedValues
  }

  private normalizeRunbookParameterValues(
    input: ExecuteRunbookHostToolInput,
  ): Record<string, string> | undefined {
    const source = input.parameterValues ?? input.parameters
    if (source === undefined) {
      return undefined
    }

    const entries = Object.entries(source).flatMap(([key, value]) => {
      const normalizedKey = key.trim()
      if (normalizedKey.length === 0 || typeof value !== 'string') {
        return []
      }
      return [[normalizedKey, value] as const]
    })

    if (entries.length === 0) {
      return undefined
    }

    return Object.fromEntries(entries)
  }
}
