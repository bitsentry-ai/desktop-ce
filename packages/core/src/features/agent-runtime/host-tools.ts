import { z } from 'zod'
import type { RunbookContext, ToolResult } from './types'
import type {
  RunbookActionRecord,
  RunbookActionParameter,
  RunbookExecutionRecord,
  RunbookParameterValues,
  RunbookRecord,
  RunbookTriggerContext,
} from '../runbooks/desktop-runbook.types'
import { MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES } from '../runbooks/desktop-runbook.types'
import type { RunbookGateway } from '../runbooks/runbook.gateway'
import {
  createRunbookCreationProposal,
  createRunbookEditProposal,
  validatePluginAuthContracts,
  type RunbookAuthoringOperation,
  type RunbookAuthoringProposal,
} from '../runbooks/authoring'
import {
  buildPluginInputSchema,
  type DesktopPluginDescriptor,
  type DesktopPluginRuntimeService,
} from '../plugins'
import { getModelCatalogProviders, resolveCatalogModel, resolveCatalogModelForProvider } from '../llm/modelCatalog'

export const listRunbooksHostToolSchema = z.object({}).strict()
export const listPluginsHostToolSchema = z.object({}).strict()
export const listModelsHostToolSchema = z.object({}).strict()

const idleTimeoutDescription = `Idle timeout in minutes, 0 to ${String(MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES)}.`
const idleTimeoutSchema = z.number()
  .int({ message: idleTimeoutDescription })
  .min(0, { message: idleTimeoutDescription })
  .max(MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES, { message: idleTimeoutDescription })
  .describe(idleTimeoutDescription)

export const executeRunbookHostToolSchema = z.object({
  runbookId: z.string().min(1).optional(),
  runbookTitle: z.string().min(1).optional(),
  parameterValues: z.record(z.string(), z.string()).optional(),
  parameters: z.record(z.string(), z.string()).optional(),
}).strict()

export const getRunbookExecutionHostToolSchema = z.object({
  executionId: z.uuid().optional(),
  waitForCompletion: z.boolean().optional(),
}).strict()

const runbookActionProposalBaseSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['shell', 'llm', 'http', 'plugin', 'external_source', 'telemetry_existing_entry', 'data_source_query', 'telemetry_ingest', 'diagnosis_diagnose', 'diagnosis_verify', 'diagnosis_recommend']),
  title: z.string().min(1), command: z.string().optional(), prompt: z.string().optional(),
  llmProviderKey: z.enum(['groq', 'kilocode', 'openai', 'anthropic', 'gemini', 'openrouter', 'claude_code', 'codex', 'opencode', 'cursor']).optional(),
  llmModel: z.string().optional(), url: z.string().optional(), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()).optional(), body: z.string().optional(),
  pluginId: z.string().optional(), pluginActionId: z.string().optional(), pluginInput: z.string().optional(), pluginAuth: z.string().optional(),
  query: z.string().optional(), sourceId: z.string().optional(),
  parameters: z.array(z.object({ id: z.string().min(1), key: z.string().min(1), label: z.string().optional(), description: z.string().optional(), defaultValue: z.string().optional(), required: z.boolean().optional(), secure: z.boolean().optional() }).strict()).optional(),
}).strict()

type RunbookActionProposal = z.infer<typeof runbookActionProposalBaseSchema>

function validateLlmActionProposal(action: RunbookActionProposal, context: z.RefinementCtx): void {
  const modelText = action.llmModel?.trim() ?? ''
  if (modelText.length === 0 || /^\{\{[^{}]+\}\}$/.test(modelText)) return

  const resolved = action.llmProviderKey === undefined
    ? resolveCatalogModel(modelText)
    : resolveCatalogModelForProvider(action.llmProviderKey, modelText)
  if (resolved === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['llmModel'],
      message: `Unknown LLM model "${modelText}". Use a model ID or display name from list_models.`,
    })
    return
  }
  if (action.llmProviderKey !== undefined && action.llmProviderKey !== resolved.providerKey) {
    context.addIssue({
      code: 'custom',
      path: ['llmProviderKey'],
      message: `Model "${modelText}" belongs to provider "${resolved.providerKey}", not "${action.llmProviderKey}".`,
    })
    return
  }
  action.llmProviderKey = resolved.providerKey
  action.llmModel = resolved.modelId
}

function validateExternalSourceActionProposal(action: RunbookActionProposal, context: z.RefinementCtx): void {
  if (action.sourceId !== undefined && action.sourceId.trim().length > 0) return
  context.addIssue({ code: 'custom', path: ['sourceId'], message: 'External Source action requires a sourceId.' })
}

function validatePluginActionProposal(action: RunbookActionProposal, context: z.RefinementCtx): void {
  if (action.pluginId === undefined || action.pluginId.trim().length === 0) {
    context.addIssue({ code: 'custom', path: ['pluginId'], message: 'Plugin action requires a pluginId.' })
  }
  if (action.pluginActionId === undefined || action.pluginActionId.trim().length === 0) {
    context.addIssue({ code: 'custom', path: ['pluginActionId'], message: 'Plugin action requires a pluginActionId.' })
  }
}

const runbookActionProposalSchema = runbookActionProposalBaseSchema.superRefine((action, context) => {
  if (action.type === 'llm') validateLlmActionProposal(action, context)
  if (action.type === 'external_source') validateExternalSourceActionProposal(action, context)
  if (action.type === 'plugin') validatePluginActionProposal(action, context)
})
const runbookAuthoringOperationSchema = z.object({
  id: z.string().min(1), type: z.enum(['update_metadata', 'add_action', 'update_action', 'delete_action', 'reorder_actions']), rationale: z.string().min(1),
  metadata: z.object({ title: z.string().optional(), description: z.string().optional(), idleTimeout: idleTimeoutSchema.optional() }).strict().optional(),
  action: runbookActionProposalSchema.optional(), actionId: z.string().min(1).optional(), insertAfterActionId: z.string().min(1).nullable().optional(), actionIdsInOrder: z.array(z.string().min(1)).optional(),
}).strict()
export const proposeRunbookEditHostToolSchema = z.object({ runbookId: z.string().min(1).optional(), runbookTitle: z.string().min(1).optional(), prompt: z.string().min(1), operations: z.array(runbookAuthoringOperationSchema).min(1) }).strict()
export const proposeRunbookCreateHostToolSchema = z.object({ prompt: z.string().min(1), draftRunbook: z.object({ title: z.string().min(1), description: z.string().default(''), idleTimeout: idleTimeoutSchema.optional(), actions: z.array(runbookActionProposalSchema).min(1) }).strict() }).strict()

export const RUNBOOK_COMPLETION_WAIT_TIMEOUT_MS = 30_000
export const RUNBOOK_COMPLETION_WAIT_SECONDS = RUNBOOK_COMPLETION_WAIT_TIMEOUT_MS / 1_000

export type HostToolName =
  | 'list_runbooks'
  | 'list_plugins'
  | 'list_models'
  | 'execute_runbook'
  | 'get_runbook_execution'
  | 'propose_runbook_edit'
  | 'propose_runbook_create'

export interface AgentSessionRef {
  id: string
  currentTurnId?: string
  incidentThreadId?: string
  accessLevel?: 'auto-accept-edits' | 'full-access'
  runbookContext?: RunbookContext
  latestRunbookExecutionId?: string
  latestRunbookResultId?: string
  latestRunbookTitle?: string
  latestJournalTimeWindowParameters?: RunbookParameterValues
  currentTurnRunbookExecutionLookups?: Set<string>
  currentTurnStartedRunbookExecutionIds?: Set<string>
  runbookAuthoringProposals?: RunbookAuthoringProposal[]
  hasRunbookParameters?: boolean
  hasMultipleRunbooksInPlay?: boolean
}

export type HostToolEvent = {
  toolCallId: string
  toolName: HostToolName
  args: Record<string, unknown>
  timestamp: string
} & (
  | { type: 'started' }
  | { type: 'completed'; result: ToolResult }
  | { type: 'failed'; result: ToolResult }
)

export interface HostToolContext {
  gateway: RunbookGateway
  session: AgentSessionRef
  buildRequestKey?: (
    session: AgentSessionRef,
    runbook: RunbookRecord,
    parameterValues: RunbookParameterValues | undefined,
  ) => string
  resolveParameterValues?: (
    session: AgentSessionRef,
    runbook: RunbookRecord,
    input: ExecuteRunbookHostToolInput,
  ) => RunbookParameterValues | undefined
  summarizeExecution?: (execution: RunbookExecutionRecord) => Record<string, unknown>
  rememberExecution?: (session: AgentSessionRef, execution: RunbookExecutionRecord) => void
  listAuthorableRunbooks?: () => Promise<RunbookRecord[]>
  pluginRuntime?: Pick<DesktopPluginRuntimeService, 'listPlugins'>
  onToolEvent?: (event: HostToolEvent) => void
}

export interface HostToolSpec<Args> {
  name: HostToolName
  description: string
  argsSchema: z.ZodObject<z.ZodRawShape>
  handler(context: HostToolContext, args: Args): Promise<ToolResult>
}

export type ExecuteRunbookHostToolInput = z.infer<typeof executeRunbookHostToolSchema>
export type GetRunbookExecutionHostToolInput = z.infer<typeof getRunbookExecutionHostToolSchema>
export type ProposeRunbookEditHostToolInput = z.infer<typeof proposeRunbookEditHostToolSchema>
export type ProposeRunbookCreateHostToolInput = z.infer<typeof proposeRunbookCreateHostToolSchema>

type HostToolValidationError = {
  code: 'INVALID_TOOL_ARGUMENTS'
  toolName: HostToolName
  issues: Array<{ path: string; message: string }>
}

let nextHostToolCallSequence = 0

function createHostToolCallId(toolName: HostToolName): string {
  nextHostToolCallSequence += 1
  return `host-${toolName}-${nextHostToolCallSequence}`
}

function emitHostToolEvent(
  context: HostToolContext,
  event: HostToolEvent,
): void {
  context.onToolEvent?.(event)
}

function structuredToolError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): ToolResult {
  return {
    error: JSON.stringify({ code, message, ...extra }),
  }
}

function createValidationError(
  toolName: HostToolName,
  error: z.ZodError<unknown>,
): ToolResult {
  const issues: HostToolValidationError['issues'] = error.issues.map((issue) => ({
    path: issue.path.join('.') || '$',
    message: issue.message,
  }))
  return structuredToolError(
    'INVALID_TOOL_ARGUMENTS',
    `Invalid arguments for ${toolName}. Correct the fields and retry.`,
    { toolName, issues },
  )
}

function normalizeParameterValues(input: ExecuteRunbookHostToolInput): RunbookParameterValues | undefined {
  const source = input.parameterValues ?? input.parameters
  if (source === undefined) return undefined

  const entries = Object.entries(source).flatMap(([key, value]) => {
    const normalizedKey = key.trim()
    return normalizedKey.length > 0 ? [[normalizedKey, value] as const] : []
  })
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function defaultRequestKey(
  session: AgentSessionRef,
  runbook: RunbookRecord,
  parameterValues: RunbookParameterValues | undefined,
): string {
  const normalizedParameters = Object.fromEntries(
    Object.entries(parameterValues ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  )
  return [
    session.id,
    session.currentTurnId ?? 'unknown-turn',
    runbook.id,
    String(runbook.revisionNumber),
    JSON.stringify(normalizedParameters),
  ].join(':')
}

function normalizeLookupTokens(value: string): string[] {
  const ignoredTokens = new Set(['a', 'an', 'and', 'for', 'from', 'id', 'in', 'of', 'rb', 'runbook', 'the', 'to'])
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !ignoredTokens.has(token))
}

function resolveSyntheticRunbookId(runbooks: RunbookRecord[], runbookId: string): RunbookRecord | null {
  const lookupTokens = normalizeLookupTokens(runbookId)
  if (lookupTokens.length < 2) return null

  const matches = runbooks
    .map((runbook) => ({
      runbook,
      score: lookupTokens.filter((token) =>
        normalizeLookupTokens(`${runbook.title} ${runbook.description}`).includes(token),
      ).length,
    }))
    .filter(({ score }) => score >= Math.min(lookupTokens.length, 2))
    .sort((left, right) => right.score - left.score)

  if (matches.length === 0 || (matches.length > 1 && matches[0].score === matches[1].score)) {
    return null
  }
  return matches[0].runbook
}

function staleRunbookIdError(runbooks: RunbookRecord[], runbookId: string, runbookTitle?: string): Error {
  const normalizedTitle = runbookTitle?.trim().toLowerCase()
  const matchingTitles = normalizedTitle === undefined || normalizedTitle.length === 0
    ? []
    : runbooks.filter((runbook) => runbook.title.toLowerCase().includes(normalizedTitle))
  const hint = matchingTitles.length === 0
    ? ''
    : ` Live title hint: ${describeRunbookCandidates(matchingTitles)}.`
  return new Error(`Runbook id ${runbookId} was not found and may be stale. Call list_runbooks, then retry execute_runbook with a current id.${hint}`)
}

function resolveRunbookByTitle(runbooks: RunbookRecord[], runbookTitle: string, staleRunbookId?: string): RunbookRecord | null {
  const normalizedTitle = runbookTitle.toLowerCase()
  const exactMatches = runbooks.filter((runbook) => runbook.title.trim().toLowerCase() === normalizedTitle)
  if (exactMatches.length === 1) return exactMatches[0]
  if (exactMatches.length > 1) {
    if (staleRunbookId !== undefined) throw staleRunbookIdError(runbooks, staleRunbookId, runbookTitle)
    throw new Error(`Multiple runbooks exactly match "${runbookTitle}". Use runbookId. Matches: ${describeRunbookCandidates(exactMatches)}`)
  }
  const partialMatches = runbooks.filter((runbook) => runbook.title.toLowerCase().includes(normalizedTitle))
  if (partialMatches.length === 1) return partialMatches[0]
  if (partialMatches.length > 1) {
    if (staleRunbookId !== undefined) throw staleRunbookIdError(runbooks, staleRunbookId, runbookTitle)
    throw new Error(`Multiple runbooks match "${runbookTitle}". Use runbookId. Matches: ${describeRunbookCandidates(partialMatches)}`)
  }
  return null
}

function findRunbookById(runbooks: RunbookRecord[], runbookId: string | undefined): RunbookRecord | undefined {
  return runbookId === undefined || runbookId.length === 0 ? undefined : runbooks.find((runbook) => runbook.id === runbookId)
}

function findUniqueExactRunbookTitle(runbooks: RunbookRecord[], runbookTitle: string): RunbookRecord | undefined {
  const matches = runbooks.filter((runbook) => runbook.title.trim().toLowerCase() === runbookTitle.toLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

function resolveRequestedRunbookById(
  runbooks: RunbookRecord[],
  runbookId: string | undefined,
  runbookTitle: string | undefined,
): RunbookRecord | null {
  const byId = findRunbookById(runbooks, runbookId)
  if (byId !== undefined) return byId
  if (runbookId === undefined || runbookId.length === 0) return null
  if (runbookTitle !== undefined && runbookTitle.length > 0) {
    const exactTitleMatch = findUniqueExactRunbookTitle(runbooks, runbookTitle)
    if (exactTitleMatch !== undefined) return exactTitleMatch
  }
  const syntheticMatch = resolveSyntheticRunbookId(runbooks, runbookId)
  if (syntheticMatch !== null) return syntheticMatch
  if (runbookTitle === undefined || runbookTitle.length === 0) throw staleRunbookIdError(runbooks, runbookId)
  return null
}

async function resolveRunbookReference(
  context: HostToolContext,
  input: ExecuteRunbookHostToolInput,
): Promise<RunbookRecord> {
  const runbooks = await context.gateway.listExecutable()
  const runbookId = input.runbookId?.trim()
  const runbookTitle = input.runbookTitle?.trim()

  const idMatch = resolveRequestedRunbookById(runbooks, runbookId, runbookTitle)
  if (idMatch !== null) return idMatch

  if (runbookTitle !== undefined && runbookTitle.length > 0) {
    const titleMatch = resolveRunbookByTitle(runbooks, runbookTitle, runbookId)
    if (titleMatch !== null) return titleMatch
    if (runbookId !== undefined && runbookId.length > 0) throw staleRunbookIdError(runbooks, runbookId, runbookTitle)
    throw new Error(`Runbook not found for title: ${runbookTitle}`)
  }

  const activeRunbook = findRunbookById(runbooks, context.session.runbookContext?.id)
  if (activeRunbook !== undefined) return activeRunbook

  throw new Error('execute_runbook requires runbookId or runbookTitle when there is no active runbook context')
}

function summarizeExecution(execution: RunbookExecutionRecord): Record<string, unknown> {
  return {
    executionId: execution.executionId,
    runbookId: execution.runbookId,
    runbookTitle: execution.runbookTitle,
    status: execution.status,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    steps: execution.steps.map((step) => ({
      order: step.order,
      title: step.title,
      type: step.type,
      status: step.status,
    })),
  }
}

function isTerminalExecution(execution: RunbookExecutionRecord): boolean {
  return (
    execution.status === 'completed' ||
    execution.status === 'failed' ||
    execution.status === 'cancelled' ||
    execution.status === 'claim_expired'
  )
}

async function waitForExecutionCompletion(
  context: HostToolContext,
  execution: RunbookExecutionRecord,
): Promise<RunbookExecutionRecord> {
  const completedExecution = await context.gateway.waitForCompletion(execution.executionId, {
    timeoutMs: RUNBOOK_COMPLETION_WAIT_TIMEOUT_MS,
  })
  if (completedExecution !== null) return completedExecution

  return await context.gateway.get(execution.executionId) ?? execution
}

function completionWaitMetadata(execution: RunbookExecutionRecord): Record<string, unknown> {
  return isTerminalExecution(execution)
    ? {}
    : {
        stillRunning: true,
        waitedSeconds: RUNBOOK_COMPLETION_WAIT_SECONDS,
      }
}

function buildTriggerContext(session: AgentSessionRef): RunbookTriggerContext | undefined {
  if (session.incidentThreadId === undefined || session.incidentThreadId.length === 0) {
    return undefined
  }
  return { entrypoint: 'incident_workspace', incidentThreadId: session.incidentThreadId }
}

type CatalogParameter = {
  key: string
  required: boolean
  description?: string
  defaultValue?: string
}

function publicCatalogParameterMetadata(parameter: RunbookActionParameter): Partial<CatalogParameter> {
  if (parameter.secure === true) return {}

  return {
    ...(parameter.description === undefined || parameter.description.length === 0
      ? {}
      : { description: parameter.description }),
    ...(parameter.defaultValue === undefined || parameter.defaultValue.length === 0
      ? {}
      : { defaultValue: parameter.defaultValue }),
  }
}

function mergeCatalogParameter(
  existing: CatalogParameter | undefined,
  parameter: RunbookActionParameter,
): CatalogParameter {
  return {
    ...existing,
    key: parameter.key,
    required: existing?.required === true || parameter.required !== false,
    ...publicCatalogParameterMetadata(parameter),
  }
}

function summarizeRunbookForCatalog(runbook: RunbookRecord): Record<string, unknown> {
  const parameters = new Map<string, CatalogParameter>()
  for (const action of runbook.actions) {
    for (const parameter of action.parameters ?? []) {
      parameters.set(parameter.key, mergeCatalogParameter(parameters.get(parameter.key), parameter))
    }
  }
  return {
    id: runbook.id,
    title: runbook.title,
    description: runbook.description,
    actionCount: runbook.actions.length,
    actionTypes: [...new Set(runbook.actions.map((action) => action.type))],
    actions: runbook.actions.map((action) => ({
      id: action.id,
      type: action.type,
      title: action.title,
    })),
    ...(parameters.size === 0 ? {} : { parameters: [...parameters.values()] }),
  }
}

async function listRunbooks(context: HostToolContext): Promise<ToolResult> {
  const runbooks = await context.gateway.listExecutable()
  return {
    output: JSON.stringify({
      runbooks: runbooks.map(summarizeRunbookForCatalog),
    }, null, 2),
  }
}

function summarizePluginForCatalog(plugin: DesktopPluginDescriptor): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    auth: {
      fields: plugin.auth.fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        secret: field.secret === true,
      })),
    },
    actions: plugin.actions.map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      riskLevel: action.riskLevel,
      inputSchema: z.toJSONSchema(buildPluginInputSchema(action.fields)),
    })),
  }
}

async function listPlugins(context: HostToolContext): Promise<ToolResult> {
  const plugins = context.pluginRuntime?.listPlugins() ?? []
  return {
    output: JSON.stringify({
      plugins: plugins.map(summarizePluginForCatalog),
    }, null, 2),
  }
}

async function listModels(): Promise<ToolResult> {
  return {
    output: JSON.stringify({
      source: 'static_catalog',
      providers: getModelCatalogProviders().map((provider) => ({
        providerKey: provider.providerKey,
        displayName: provider.displayName,
        models: provider.models.map((model) => ({
          modelId: model.id,
          displayName: model.displayName,
        })),
      })),
    }, null, 2),
  }
}

function applyPluginAuthValidation(
  proposal: RunbookAuthoringProposal,
  context: HostToolContext,
): RunbookAuthoringProposal {
  const plugins = context.pluginRuntime?.listPlugins()
  if (plugins === undefined) return proposal

  const errors = validatePluginAuthContracts(proposal.proposedRunbook, plugins)
  if (errors.length === 0) return proposal

  proposal.validation = {
    ...proposal.validation,
    valid: false,
    errors: [...proposal.validation.errors, ...errors],
  }
  return proposal
}

async function executeRunbook(
  context: HostToolContext,
  input: ExecuteRunbookHostToolInput,
): Promise<ToolResult> {
  const runbook = await resolveRunbookReference(context, input)
  const parameterValues = context.resolveParameterValues?.(context.session, runbook, input) ?? normalizeParameterValues(input)
  const execution = await context.gateway.start({
    runbookId: runbook.id,
    expectedRevisionNumber: runbook.revisionNumber,
    requestKey: (context.buildRequestKey ?? defaultRequestKey)(context.session, runbook, parameterValues),
    incidentId: context.session.incidentThreadId,
    parameterValues,
    source: 'agent',
    triggerContext: buildTriggerContext(context.session),
    accessLevel: context.session.accessLevel,
  })
  context.session.latestRunbookExecutionId = execution.executionId
  context.session.latestRunbookResultId = execution.resultId
  context.session.latestRunbookTitle = runbook.title
  context.session.currentTurnStartedRunbookExecutionIds?.add(execution.executionId)

  return {
    output: JSON.stringify({
      status: execution.execution.status,
      runbookId: runbook.id,
      runbookTitle: runbook.title,
      executionId: execution.executionId,
      resultId: execution.resultId,
      deduplicated: execution.deduplicated,
      execution: (context.summarizeExecution ?? summarizeExecution)(execution.execution),
    }, null, 2),
  }
}

async function getRunbookExecution(
  context: HostToolContext,
  input: GetRunbookExecutionHostToolInput,
): Promise<ToolResult> {
  const requestedExecutionId = input.executionId?.trim()
  let execution: RunbookExecutionRecord | null = null
  if (requestedExecutionId !== undefined && requestedExecutionId.length > 0) {
    execution = await context.gateway.get(requestedExecutionId)
    const latestExecutionId = context.session.latestRunbookExecutionId
    if (
      execution === null &&
      latestExecutionId !== undefined &&
      latestExecutionId !== requestedExecutionId &&
      context.session.currentTurnStartedRunbookExecutionIds?.has(latestExecutionId) === true
    ) {
      execution = await context.gateway.get(latestExecutionId)
    }
  } else if (context.session.latestRunbookExecutionId !== undefined) {
    execution = await context.gateway.get(context.session.latestRunbookExecutionId)
  } else if (context.session.incidentThreadId !== undefined && context.session.incidentThreadId.length > 0) {
    execution = await context.gateway.getLatestForIncidentThread(context.session.incidentThreadId)
  }

  if (execution === null) {
    throw new Error(requestedExecutionId === undefined
      ? 'No runbook execution was found for this incident yet'
      : `Runbook execution not found: ${requestedExecutionId}`)
  }

  if (input.waitForCompletion === true) {
    execution = await waitForExecutionCompletion(context, execution)
    context.session.latestRunbookExecutionId = execution.executionId
    context.session.latestRunbookTitle = execution.runbookTitle
    context.rememberExecution?.(context.session, execution)
    return {
      output: JSON.stringify({
        ...(context.summarizeExecution ?? summarizeExecution)(execution),
        ...completionWaitMetadata(execution),
      }, null, 2),
    }
  }

  const lookups = context.session.currentTurnRunbookExecutionLookups ?? new Set<string>()
  if (isTerminalExecution(execution) && lookups.has(execution.executionId)) {
    return structuredToolError(
      'REPEATED_RUNBOOK_EXECUTION_LOOKUP',
      'This terminal runbook execution was already inspected in this turn. Call get_runbook_execution with waitForCompletion: true when you need a completion-aware result.',
      { executionId: execution.executionId },
    )
  }
  if (isTerminalExecution(execution)) {
    lookups.add(execution.executionId)
  }
  context.session.currentTurnRunbookExecutionLookups = lookups
  context.session.latestRunbookExecutionId = execution.executionId
  context.session.latestRunbookTitle = execution.runbookTitle
  context.rememberExecution?.(context.session, execution)
  return { output: JSON.stringify((context.summarizeExecution ?? summarizeExecution)(execution), null, 2) }
}

async function resolveAuthorableRunbookReference(context: HostToolContext, input: ProposeRunbookEditHostToolInput): Promise<RunbookRecord> {
  const runbooks = await (context.listAuthorableRunbooks?.() ?? context.gateway.listExecutable())
  const runbookId = input.runbookId?.trim()
  const runbookTitle = input.runbookTitle?.trim()
  const byId = findRunbookById(runbooks, runbookId)
  if (byId !== undefined) return byId
  if (runbookTitle !== undefined && runbookTitle.length > 0) {
    const titleMatch = resolveRunbookByTitle(runbooks, runbookTitle)
    if (titleMatch !== null) return titleMatch
  }
  const active = findRunbookById(runbooks, context.session.runbookContext?.id)
  if (active !== undefined) return active
  throw new Error('propose_runbook_edit requires runbookId or runbookTitle when there is no active runbook context')
}

function describeRunbookCandidates(runbooks: RunbookRecord[]): string {
  return runbooks.map((runbook) => `${runbook.id} (${runbook.title})`).join(', ')
}

function summarizeAuthoringProposal(proposal: RunbookAuthoringProposal): Record<string, unknown> {
  return {
    status: proposal.status, approvalRequired: true, saved: false, proposalId: proposal.id, kind: proposal.kind,
    incidentThreadId: proposal.incidentThreadId,
    targetRunbookId: proposal.kind === 'edit_existing_runbook' ? proposal.targetRunbookId : undefined,
    targetRevisionNumber: proposal.kind === 'edit_existing_runbook' ? proposal.targetRevisionNumber : undefined,
    proposedRunbook: { id: proposal.proposedRunbook.id, title: proposal.proposedRunbook.title, description: proposal.proposedRunbook.description, revisionNumber: proposal.proposedRunbook.revisionNumber, actionCount: proposal.proposedRunbook.actions.length, actions: proposal.proposedRunbook.actions.map((action) => ({ id: action.id, type: action.type, title: action.title })) },
    validation: proposal.validation, operationDiffs: proposal.operationDiffs,
    nextStep: 'Show this proposal to the operator. Do not claim it was saved; it requires explicit approve, deny, or revise action.',
  }
}

async function proposeRunbookEdit(context: HostToolContext, input: ProposeRunbookEditHostToolInput): Promise<ToolResult> {
  const proposal = createRunbookEditProposal({ incidentThreadId: context.session.incidentThreadId, prompt: input.prompt, targetRunbook: await resolveAuthorableRunbookReference(context, input), operations: input.operations.map((operation) => ({ ...operation, action: operation.action as RunbookActionRecord | undefined })) as RunbookAuthoringOperation[] })
  applyPluginAuthValidation(proposal, context)
  context.session.runbookAuthoringProposals ??= []
  context.session.runbookAuthoringProposals.push(proposal)
  return { output: JSON.stringify(summarizeAuthoringProposal(proposal), null, 2) }
}

async function proposeRunbookCreate(context: HostToolContext, input: ProposeRunbookCreateHostToolInput): Promise<ToolResult> {
  const proposal = createRunbookCreationProposal({ incidentThreadId: context.session.incidentThreadId, prompt: input.prompt, draftRunbook: { ...input.draftRunbook, actions: input.draftRunbook.actions as RunbookActionRecord[] } })
  applyPluginAuthValidation(proposal, context)
  context.session.runbookAuthoringProposals ??= []
  context.session.runbookAuthoringProposals.push(proposal)
  return { output: JSON.stringify(summarizeAuthoringProposal(proposal), null, 2) }
}

export const hostTools = [
  {
    name: 'list_runbooks',
    description: 'List available runbooks that can be executed for the incident.',
    argsSchema: listRunbooksHostToolSchema,
    handler: async (context: HostToolContext) => await listRunbooks(context),
  },
  {
    name: 'list_plugins',
    description: 'List installed plugins, their action IDs, input JSON schemas, and auth field contracts. Use the exact auth field keys returned here when constructing pluginAuth. Auth values and secrets are never returned.',
    argsSchema: listPluginsHostToolSchema,
    handler: async (context: HostToolContext) => await listPlugins(context),
  },
  {
    name: 'list_models',
    description: 'List canonical model IDs and display names available for LLM runbook actions from the static catalog. Settings may also show saved or discovered provider models; use a catalog modelId or exact display name when proposing or editing a runbook.',
    argsSchema: listModelsHostToolSchema,
    handler: async () => await listModels(),
  },
  {
    name: 'execute_runbook',
    description: 'Start a real runbook execution by runbookId or runbookTitle. If the user specifies placeholder values, pass them in parameterValues. Saved defaults are fallback values only.',
    argsSchema: executeRunbookHostToolSchema,
    handler: async (context: HostToolContext, args: ExecuteRunbookHostToolInput) => await executeRunbook(context, args),
  },
  {
    name: 'get_runbook_execution',
    description: 'Get a previously started runbook execution. Set waitForCompletion to true to wait up to 30 seconds for a terminal result, then return the latest snapshot; otherwise return the latest snapshot immediately. If executionId is omitted, use the latest known runbook execution for the current incident.',
    argsSchema: getRunbookExecutionHostToolSchema,
    handler: async (context: HostToolContext, args: GetRunbookExecutionHostToolInput) => await getRunbookExecution(context, args),
  },
  {
    name: 'propose_runbook_edit',
    description: 'Create a pending, non-mutating runbook edit proposal for user approval. This never saves changes.',
    argsSchema: proposeRunbookEditHostToolSchema,
    handler: async (context: HostToolContext, args: ProposeRunbookEditHostToolInput) => await proposeRunbookEdit(context, args),
  },
  {
    name: 'propose_runbook_create',
    description: 'Create a pending, non-mutating proposal for a new runbook draft. This never saves changes.',
    argsSchema: proposeRunbookCreateHostToolSchema,
    handler: async (context: HostToolContext, args: ProposeRunbookCreateHostToolInput) => await proposeRunbookCreate(context, args),
  },
] as const satisfies readonly HostToolSpec<unknown>[]

export function getHostTools(): readonly HostToolSpec<unknown>[] {
  return hostTools
}

export function getHostTool(name: string): HostToolSpec<unknown> | undefined {
  return hostTools.find((tool) => tool.name === name)
}

export function isHostToolName(name: string): name is HostToolName {
  return getHostTool(name) !== undefined
}

function normalizeHostToolArgs(rawArgs: unknown): unknown {
  // Some MCP clients serialize a zero-argument call as null or omit arguments
  // altogether. Both forms mean the same thing as an empty object; passing
  // either directly to a strict object schema turns a valid call into a
  // spurious validation rejection.
  return rawArgs === null || rawArgs === undefined ? {} : rawArgs
}

function eventArgs(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
    return rawArgs as Record<string, unknown>
  }
  return {}
}

export async function executeHostTool(
  context: HostToolContext,
  name: string,
  rawArgs: unknown,
): Promise<ToolResult | null> {
  const tool = getHostTool(name)
  if (tool === undefined) return null
  const normalizedArgs = normalizeHostToolArgs(rawArgs)
  const diagnosticArgs = eventArgs(normalizedArgs)

  const toolCallId = createHostToolCallId(tool.name)
  const startedAt = new Date().toISOString()
  emitHostToolEvent(context, {
    type: 'started',
    toolCallId,
    toolName: tool.name,
    args: diagnosticArgs,
    timestamp: startedAt,
  })

  const parsed = tool.argsSchema.safeParse(normalizedArgs)
  if (!parsed.success) {
    const result = createValidationError(tool.name, parsed.error)
    emitHostToolEvent(context, {
      type: 'failed',
      toolCallId,
      toolName: tool.name,
      args: diagnosticArgs,
      result,
      timestamp: new Date().toISOString(),
    })
    return result
  }

  try {
    const result = await tool.handler(context, parsed.data as never)
    emitHostToolEvent(context, {
      type: result.error === undefined ? 'completed' : 'failed',
      toolCallId,
      toolName: tool.name,
      args: parsed.data,
      result,
      timestamp: new Date().toISOString(),
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result = structuredToolError('HOST_TOOL_EXECUTION_FAILED', message, { toolName: tool.name })
    emitHostToolEvent(context, {
      type: 'failed',
      toolCallId,
      toolName: tool.name,
      args: parsed.data,
      result,
      timestamp: new Date().toISOString(),
    })
    return result
  }
}
