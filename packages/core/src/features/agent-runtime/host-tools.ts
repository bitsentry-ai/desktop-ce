import { z } from 'zod'
import type { RunbookContext, ToolResult } from './types'
import type {
  RunbookExecutionRecord,
  RunbookParameterValues,
  RunbookRecord,
  RunbookTriggerContext,
} from '../runbooks/desktop-runbook.types'
import type { RunbookGateway } from '../runbooks/runbook.gateway'

export const listRunbooksHostToolSchema = z.object({}).strict()

export const executeRunbookHostToolSchema = z.object({
  runbookId: z.string().min(1).optional(),
  runbookTitle: z.string().min(1).optional(),
  parameterValues: z.record(z.string(), z.string()).optional(),
  parameters: z.record(z.string(), z.string()).optional(),
}).strict()

export const getRunbookExecutionHostToolSchema = z.object({
  executionId: z.uuid().optional(),
}).strict()

export type HostToolName =
  | 'list_runbooks'
  | 'execute_runbook'
  | 'get_runbook_execution'

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

async function resolveRunbookReference(
  context: HostToolContext,
  input: ExecuteRunbookHostToolInput,
): Promise<RunbookRecord> {
  const runbooks = await context.gateway.listExecutable()
  const runbookId = input.runbookId?.trim()
  const runbookTitle = input.runbookTitle?.trim()

  if (runbookId !== undefined && runbookId.length > 0) {
    const byId = runbooks.find((runbook) => runbook.id === runbookId)
    if (byId !== undefined) return byId

    if (runbookTitle !== undefined && runbookTitle.length > 0) {
      const exactTitleMatch = runbooks.filter(
        (runbook) => runbook.title.trim().toLowerCase() === runbookTitle.toLowerCase(),
      )
      if (exactTitleMatch.length === 1) return exactTitleMatch[0]
    }

    const syntheticMatch = resolveSyntheticRunbookId(runbooks, runbookId)
    if (syntheticMatch !== null) return syntheticMatch
    if (runbookTitle === undefined || runbookTitle.length === 0) {
      throw new Error(`Runbook not found for id: ${runbookId}`)
    }
  }

  if (runbookTitle !== undefined && runbookTitle.length > 0) {
    const normalizedTitle = runbookTitle.toLowerCase()
    const exactMatches = runbooks.filter((runbook) => runbook.title.trim().toLowerCase() === normalizedTitle)
    if (exactMatches.length === 1) return exactMatches[0]

    const partialMatches = runbooks.filter((runbook) => runbook.title.toLowerCase().includes(normalizedTitle))
    if (partialMatches.length === 1) return partialMatches[0]
    if (partialMatches.length > 1) {
      throw new Error(`Multiple runbooks match "${runbookTitle}". Use runbookId. Matches: ${partialMatches.map((runbook) => runbook.title).join(', ')}`)
    }
    throw new Error(`Runbook not found for title: ${runbookTitle}`)
  }

  const activeRunbookId = context.session.runbookContext?.id
  if (activeRunbookId !== undefined && activeRunbookId.length > 0) {
    const activeRunbook = runbooks.find((runbook) => runbook.id === activeRunbookId)
    if (activeRunbook !== undefined) return activeRunbook
  }

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

function buildTriggerContext(session: AgentSessionRef): RunbookTriggerContext | undefined {
  if (session.incidentThreadId === undefined || session.incidentThreadId.length === 0) {
    return undefined
  }
  return { entrypoint: 'incident_workspace', incidentThreadId: session.incidentThreadId }
}

async function listRunbooks(context: HostToolContext): Promise<ToolResult> {
  const runbooks = await context.gateway.listExecutable()
  return {
    output: JSON.stringify({
      runbooks: runbooks.map((runbook) => ({
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        revisionNumber: runbook.revisionNumber,
        actionCount: runbook.actions.length,
        actionTypes: runbook.actions.map((action) => action.type),
        actionParameters: runbook.actions
          .filter((action) => action.parameters !== undefined && action.parameters.length > 0)
          .map((action) => ({
            actionId: action.id,
            actionTitle: action.title,
            parameters: action.parameters?.map((parameter) => ({
              key: parameter.key,
              description: parameter.description,
              defaultValue: parameter.defaultValue,
              required: parameter.required !== false,
            })) ?? [],
          })),
      })),
    }, null, 2),
  }
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

  const lookups = context.session.currentTurnRunbookExecutionLookups ?? new Set<string>()
  if (lookups.has(execution.executionId)) {
    return structuredToolError(
      'REPEATED_RUNBOOK_EXECUTION_LOOKUP',
      'This runbook execution was already inspected in this turn. Wait for a new execution or user request before checking again.',
      { executionId: execution.executionId },
    )
  }
  lookups.add(execution.executionId)
  context.session.currentTurnRunbookExecutionLookups = lookups
  context.session.latestRunbookExecutionId = execution.executionId
  context.session.latestRunbookTitle = execution.runbookTitle
  context.rememberExecution?.(context.session, execution)
  return { output: JSON.stringify((context.summarizeExecution ?? summarizeExecution)(execution), null, 2) }
}

export const hostTools = [
  {
    name: 'list_runbooks',
    description: 'List available runbooks that can be executed for the incident.',
    argsSchema: listRunbooksHostToolSchema,
    handler: async (context: HostToolContext) => await listRunbooks(context),
  },
  {
    name: 'execute_runbook',
    description: 'Start a real runbook execution by runbookId or runbookTitle. If the user specifies placeholder values, pass them in parameterValues. Saved defaults are fallback values only.',
    argsSchema: executeRunbookHostToolSchema,
    handler: async (context: HostToolContext, args: ExecuteRunbookHostToolInput) => await executeRunbook(context, args),
  },
  {
    name: 'get_runbook_execution',
    description: 'Get the latest snapshot for a previously started runbook execution. If executionId is omitted, use the latest known runbook execution for the current incident.',
    argsSchema: getRunbookExecutionHostToolSchema,
    handler: async (context: HostToolContext, args: GetRunbookExecutionHostToolInput) => await getRunbookExecution(context, args),
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
