import os from 'os'
import { mkdtemp, rm } from 'fs/promises'
import path from 'path'
import { codingAgentsLogger as log } from './logger.js'
import { CodexAppServerClient, type JsonRpcId } from './codex-app-server-client.js'
import { HOST_MCP_SERVER_NAME, type HostMcpEndpoint } from './host-mcp-server.service.js'
import type { LocalAiStreamDelta, LocalAiExecutionResult } from './types.js'
import {
  getCodexPolicies,
  normalizeAccessLevel,
  type AccessLevel,
  DEFAULT_ACCESS_LEVEL,
} from './composer.js'
import { getErrorMessage } from '@bitsentry-ce/core'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import { buildRunbookOnlyScope } from './runbook-only-scope.js'
import { createIsolatedCodexIncidentHome } from './codex-incident-home.js'

type LocalAiTextStreamDelta = LocalAiStreamDelta & { type: 'text'; text?: string }

const CODEX_MODELS_WITHOUT_REASONING_SUMMARIES = new Set([
  'gpt-5.3-codex-spark',
])
const CODEX_MCP_ELICITATION_METHOD = 'mcpServer/elicitation/request'

export interface CodexDebugRecorder {
  recordEvent(stage: string, data: Record<string, unknown>): void
  recordAnomaly(stage: string, data: Record<string, unknown>): void
}

export interface CodexExecutionOptions {
  prompt: string
  binaryPath: string
  abortController: AbortController
  cwd?: string
  model?: string
  accessLevel?: AccessLevel
  traitValues?: Record<string, string | boolean>
  codexArgs?: string[]
  mcpEndpoint?: HostMcpEndpoint
  onDelta?: (delta: LocalAiStreamDelta) => void
  debug?: CodexDebugRecorder
  systemPrompt?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return Object.fromEntries(Object.entries(value))
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return undefined
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }
  return undefined
}

function readStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return readString(record?.[key])
}

type CodexApprovalChoice = 'allow-host-tool' | 'allow-file-change' | 'allow-full-access' | 'deny'

function codexMcpElicitationMetadata(params: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(params)?._meta)
}

function isBitsentryMcpToolApprovalElicitation(params: unknown): boolean {
  const record = asRecord(params)
  const requestedSchema = asRecord(record?.requestedSchema)
  const properties = asRecord(requestedSchema?.properties)

  // Codex does not associate this elicitation channel with an MCP tool item.
  // bitsentry exposes only getHostTools(), so server-level approval is complete
  // while that server-surface invariant remains true.
  return readStringField(record, 'serverName') === HOST_MCP_SERVER_NAME &&
    readStringField(record, 'mode') === 'form' &&
    readStringField(requestedSchema, 'type') === 'object' &&
    properties !== undefined &&
    Object.keys(properties).length === 0
}

function summarizeCodexMcpElicitation(params: unknown): Record<string, unknown> {
  const record = asRecord(params)
  const metadata = codexMcpElicitationMetadata(params)
  return {
    paramKeys: record === undefined ? [] : Object.keys(record).sort(),
    serverName: readStringField(record, 'serverName')?.slice(0, 120) ?? null,
    mode: readStringField(record, 'mode') ?? null,
    metadataKeys: metadata === undefined ? [] : Object.keys(metadata).sort(),
    approvalKind: readStringField(metadata, 'codex_approval_kind') ?? null,
    requestedSchemaShape: summarizeRequestedSchema(record?.requestedSchema),
  }
}

function summarizeRequestedSchema(value: unknown): Record<string, unknown> | null {
  const schema = asRecord(value)
  if (schema === undefined) return null

  const properties = asRecord(schema.properties)
  return {
    keys: Object.keys(schema).sort(),
    type: readStringField(schema, 'type') ?? null,
    propertyKeys: properties === undefined ? null : Object.keys(properties).sort(),
  }
}

export function chooseCodexApprovalResponse(
  method: string,
  params: unknown,
  accessLevel: AccessLevel,
  isBitsentryHostToolCall = false,
): { choice: CodexApprovalChoice; result: Record<string, unknown> } | undefined {
  switch (method) {
    case CODEX_MCP_ELICITATION_METHOD:
      return chooseCodexMcpElicitationResponse(params)
    case 'item/tool/requestUserInput':
      return chooseCodexUserInputResponse(params, isBitsentryHostToolCall)
    case 'item/fileChange/requestApproval':
      return chooseCodexFileChangeApprovalResponse(accessLevel)
    case 'item/commandExecution/requestApproval':
      return chooseCodexCommandApprovalResponse(accessLevel)
    case 'item/permissions/requestApproval':
      return chooseCodexPermissionsApprovalResponse(params, accessLevel)
    default:
      return undefined
  }
}

function chooseCodexMcpElicitationResponse(params: unknown): { choice: CodexApprovalChoice; result: Record<string, unknown> } {
  return isBitsentryMcpToolApprovalElicitation(params)
    ? { choice: 'allow-host-tool', result: { action: 'accept', content: {}, _meta: null } }
    : { choice: 'deny', result: { action: 'decline', content: null, _meta: null } }
}

function chooseCodexUserInputResponse(params: unknown, isBitsentryHostToolCall: boolean): { choice: CodexApprovalChoice; result: Record<string, unknown> } {
  const questions = Array.isArray(asRecord(params)?.questions) ? asRecord(params)?.questions as unknown[] : []
  const answer = isBitsentryHostToolCall ? 'Allow' : '__codex_mcp_decline__'
  const answers = Object.fromEntries(questions.flatMap((question) => {
    const id = readStringField(asRecord(question), 'id')
    return id === undefined ? [] : [[id, { answers: [answer] }]]
  }))
  return { choice: isBitsentryHostToolCall ? 'allow-host-tool' : 'deny', result: { answers } }
}

function chooseCodexFileChangeApprovalResponse(accessLevel: AccessLevel): { choice: CodexApprovalChoice; result: Record<string, unknown> } {
  const fullAccess = accessLevel === 'full-access'
  return {
    choice: fullAccess || accessLevel === 'auto-accept-edits' ? 'allow-file-change' : 'deny',
    result: { decision: fullAccess ? 'acceptForSession' : 'accept' },
  }
}

function chooseCodexCommandApprovalResponse(accessLevel: AccessLevel): { choice: CodexApprovalChoice; result: Record<string, unknown> } {
  const fullAccess = accessLevel === 'full-access'
  return {
    choice: fullAccess ? 'allow-full-access' : 'deny',
    result: { decision: fullAccess ? 'acceptForSession' : 'decline' },
  }
}

function chooseCodexPermissionsApprovalResponse(params: unknown, accessLevel: AccessLevel): { choice: CodexApprovalChoice; result: Record<string, unknown> } {
  const fullAccess = accessLevel === 'full-access'
  const permissions = asRecord(asRecord(params)?.permissions) ?? {}
  return {
    choice: fullAccess ? 'allow-full-access' : 'deny',
    result: { permissions: fullAccess ? permissions : {}, scope: fullAccess ? 'session' : 'turn' },
  }
}

export function isBitsentryMcpToolItem(item: Record<string, unknown> | undefined): boolean {
  return item?.type === 'mcpToolCall' &&
    readStringField(item, 'server') === HOST_MCP_SERVER_NAME &&
    getHostTools().some((hostTool) => hostTool.name === readStringField(item, 'tool'))
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = asNumber(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

function firstNumberField(
  records: Array<Record<string, unknown> | undefined>,
  keys: string[],
): number | undefined {
  for (const record of records) {
    if (record === undefined) continue
    for (const key of keys) {
      const parsed = asNumber(record[key])
      if (parsed !== undefined) return parsed
    }
  }
  return undefined
}

function isAbortSignalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function parseCodexTokenUsage(
  params: Record<string, unknown> | undefined,
): LocalAiExecutionResult['tokenUsage'] | undefined {
  const tokenUsage = asRecord(params?.tokenUsage)
  if (tokenUsage === undefined) {
    return undefined
  }

  const total = asRecord(tokenUsage.total)
  const last = asRecord(tokenUsage.last)

  const usageRecords = [last, total]
  const inputTokens = firstNumberField(usageRecords, [
    'inputTokens',
    'input_tokens',
  ])
  const outputTokens = firstNumberField(usageRecords, [
    'outputTokens',
    'output_tokens',
  ])
  const contextTokens = firstNumberField(usageRecords, [
    'totalTokens',
    'total_tokens',
  ])
  const contextLimit = firstNumber(
    tokenUsage.modelContextWindow,
    tokenUsage.model_context_window,
  )

  if (
    inputTokens == null &&
    outputTokens == null &&
    contextTokens == null &&
    contextLimit == null
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

function getCompletedAgentMessageText(item: Record<string, unknown> | undefined): string | undefined {
  if (item?.type !== 'agentMessage') {
    return undefined
  }

  if (typeof item.text === 'string') {
    return item.text
  }

  const message = asRecord(item.message)
  return readStringField(message, 'text')
}

function getNotificationTextDelta(params: Record<string, unknown> | undefined): string | undefined {
  const delta = params?.delta ?? params?.textDelta
  return readString(delta)
}

export function codexStreamDeltasFromNotification(
  method: string,
  params: unknown,
): LocalAiStreamDelta[] {
  const record = asRecord(params)
  const text = getNotificationTextDelta(record)
  if (text === undefined) {
    return []
  }

  if (method === 'item/agentMessage/delta') {
    return [{ type: 'text', text }]
  }

  if (
    method === 'item/reasoning/textDelta' ||
    method === 'item/reasoning/summaryTextDelta'
  ) {
    return [{ type: 'reasoning', text }]
  }

  if (
    method === 'item/commandExecution/outputDelta' ||
    method === 'item/fileChange/outputDelta'
  ) {
    return [{ type: 'command_output', text }]
  }

  return []
}

export function normalizeCodexExecutionError(err: unknown): Error {
  const message = getErrorMessage(err)
  const normalizedMessage = message.toLowerCase()
  const isConfigLoadError =
    message.includes('failed to load configuration:') &&
    message.includes('config.toml')

  if (!isConfigLoadError) {
    if (
      /not supported when using codex with a chatgpt account|unsupported model|model .* (?:does not exist|not found|is not supported|unknown)/.test(normalizedMessage)
    ) {
      return new Error(`Codex model unavailable: ${message}`)
    }
    if (
      /unauthori[sz]ed|forbidden|access denied|not authenticated|permission|entitlement/.test(normalizedMessage)
    ) {
      return new Error(`Codex account access unauthorized: ${message}`)
    }
    if (err instanceof Error) return err
    return new Error(message)
  }

  let hint = 'Update your Codex config to use supported values.'
  if (message.includes('expected `fast` or `flex`')) {
    hint = 'Set `service_tier` in your Codex config to `flex` or `fast`.'
  }

  return new Error(`Codex configuration error: ${message}\n${hint}`)
}

/**
 * `codex app-server` ignores the global `--model` flag; threads silently fall
 * back to the model in ~/.codex/config.toml. The only override the app-server
 * honors is the `-c model="..."` config form, so the requested model must be
 * passed that way or the user's config default runs instead.
 */
export function withCodexModelArgs(
  codexArgs: string[],
  model: string | undefined,
): string[] {
  const args = [...codexArgs]
  if (model === undefined || model.length === 0) {
    return args
  }

  if (!hasCodexModelOverride(args)) {
    args.push('-c', `model="${model.replace(/"/g, '')}"`)
  }

  const reasoningSummariesUnsupported = CODEX_MODELS_WITHOUT_REASONING_SUMMARIES.has(model)
  if (reasoningSummariesUnsupported && !hasCodexReasoningSummaryOverride(args)) {
    args.push('-c', 'model_reasoning_summary="none"')
  }

  return args
}

function hasCodexModelOverride(args: string[]): boolean {
  return args.some((arg, index) =>
    arg === '--model' || arg.startsWith('--model=') || (arg.startsWith('model=') && args[index - 1] === '-c'),
  )
}

function hasCodexReasoningSummaryOverride(args: string[]): boolean {
  return args.some((arg, index) => arg.startsWith('model_reasoning_summary=') && args[index - 1] === '-c')
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Codex process setup, cancellation, turn lifecycle, and cleanup must remain in one ordered ownership boundary.
export async function executeCodex(
  options: CodexExecutionOptions,
): Promise<LocalAiExecutionResult> {
  const debug = options.debug
  const effectiveAccessLevel = normalizeAccessLevel(
    options.accessLevel ?? DEFAULT_ACCESS_LEVEL,
  )
  // Codex treats its thread cwd as the workspace sandbox root. Safe Tools
  // must never inherit the broad system temp directory, where unrelated app
  // data (including the live SQLite database) can be readable.
  const scratchDirectory = options.cwd === undefined && effectiveAccessLevel !== 'full-access'
    ? await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-'))
    : undefined
  const cwd = options.cwd ?? scratchDirectory ?? os.tmpdir()
  const codexArgs = withCodexModelArgs(options.codexArgs ?? [], options.model)
  let effectiveCodexArgs: string[] | undefined
  if (codexArgs.length > 0) {
    effectiveCodexArgs = codexArgs
  }
  if (isAbortSignalAborted(options.abortController.signal)) {
    if (scratchDirectory !== undefined) await rm(scratchDirectory, { recursive: true, force: true })
    return { output: '', exitCode: -1 }
  }

  let isolatedHome: Awaited<ReturnType<typeof createIsolatedCodexIncidentHome>> | undefined
  try {
    isolatedHome = options.mcpEndpoint === undefined
      ? undefined
      : await createIsolatedCodexIncidentHome()
  } catch (error) {
    if (scratchDirectory !== undefined) await rm(scratchDirectory, { recursive: true, force: true })
    throw error
  }
  if (isAbortSignalAborted(options.abortController.signal)) {
    await isolatedHome?.dispose()
    if (scratchDirectory !== undefined) await rm(scratchDirectory, { recursive: true, force: true })
    return { output: '', exitCode: -1 }
  }
  const client = new CodexAppServerClient(options.binaryPath, cwd, effectiveCodexArgs, {
    home: isolatedHome?.home,
  })

  const MAX_OUTPUT_LENGTH = 50_000
  let output = ''
  let threadId: string | undefined
  let activeTurnId: string | undefined
  let tokenUsage: LocalAiExecutionResult['tokenUsage']
  let pendingAssistantMessageBreak = false
  const streamedAgentMessageIds = new Set<string>()
  const bitsentryMcpToolItemIds = new Set<string>()
  let resolveTokenUsageSeen: (() => void) | undefined
  const tokenUsageSeen = new Promise<void>((resolve) => {
    resolveTokenUsageSeen = resolve
  })

  const appendAssistantText = (text: string): string => {
    if (text.length === 0) return ''

    let prefix = ''
    if (
      pendingAssistantMessageBreak &&
      output.trim().length > 0 &&
      !/\s$/.test(output)
    ) {
      prefix = '\n\n'
    }

    pendingAssistantMessageBreak = false
    const nextText = `${prefix}${text}`
    output += nextText
    if (output.length > MAX_OUTPUT_LENGTH) output = output.slice(0, MAX_OUTPUT_LENGTH)
    return nextText
  }

  const onAbort = () => {
    if (threadId !== undefined && activeTurnId !== undefined) {
      client.sendRequest('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {
        // Interrupt failed, kill will handle it
      })
    }
    // `kill` owns the bounded SIGTERM/SIGKILL escalation. Do not leave a
    // provider-local timer behind after the parent session has finished.
    void client.kill()
  }

  options.abortController.signal.addEventListener('abort', onAbort, { once: true })

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Protocol notifications update one shared turn state machine whose ordering is required for streamed output and approvals.
  client.on('notification', (notification: { method: string; params: unknown }) => {
    const params = asRecord(notification.params)

    switch (notification.method) {
      case 'thread/started': {
        const thread = asRecord(params?.thread)
        threadId =
          threadId ??
          readStringField(thread, 'id') ??
          readStringField(params, 'threadId')
        break
      }

      case 'turn/started': {
        const turn = asRecord(params?.turn)
        activeTurnId =
          readStringField(turn, 'id') ??
          readStringField(params, 'turnId')
        options.onDelta?.({ type: 'status', status: 'started' })
        break
      }

      case 'thread/tokenUsage/updated': {
        const nextTokenUsage = parseCodexTokenUsage(params)
        if (nextTokenUsage !== undefined) {
          tokenUsage = nextTokenUsage
          options.onDelta?.({ type: 'token_usage', tokenUsage: nextTokenUsage })
          resolveTokenUsageSeen?.()
          resolveTokenUsageSeen = undefined
        }
        break
      }

      case 'item/agentMessage/delta': {
        const itemId = readStringField(params, 'itemId')
        if (itemId !== undefined) {
          streamedAgentMessageIds.add(itemId)
        }
        const deltas = codexStreamDeltasFromNotification(notification.method, params)
        const textDelta = deltas.find(
          (delta): delta is LocalAiTextStreamDelta => delta.type === 'text',
        )
        if (
          textDelta?.text !== undefined &&
          textDelta.text.length > 0 &&
          output.length < MAX_OUTPUT_LENGTH
        ) {
          const emittedText = appendAssistantText(textDelta.text)
          debug?.recordEvent('codex.delta_received', {
            provider: 'codex',
            accessLevel: effectiveAccessLevel,
            threadId: threadId ?? null,
            turnId: activeTurnId ?? null,
            deltaKind: textDelta.type,
            deltaLength: textDelta.text.length,
            accumulatedLength: output.length,
          })
          if (emittedText.length > 0) {
            options.onDelta?.({ type: 'text', text: emittedText })
          }
        }
        break
      }

      case 'item/completed': {
        const item = asRecord(params?.item)
        const finalText = getCompletedAgentMessageText(item)
        const itemId =
          readStringField(item, 'id') ??
          readStringField(params, 'itemId')
        const streamed = itemId !== undefined && streamedAgentMessageIds.has(itemId)
        const shouldAppendCompletedText =
          finalText !== undefined &&
          (itemId !== undefined ? !streamed : output.length === 0)
        if (shouldAppendCompletedText && finalText !== undefined) {
          const emittedText = appendAssistantText(finalText)
          debug?.recordAnomaly('codex.completed_without_stream_deltas', {
            provider: 'codex',
            accessLevel: effectiveAccessLevel,
            threadId: threadId ?? null,
            turnId: activeTurnId ?? null,
            finalTextLength: emittedText.length,
          })
          if (emittedText.length > 0) {
            options.onDelta?.({ type: 'text', text: emittedText })
          }
        }
        break
      }

      case 'item/started': {
        const item = asRecord(params?.item)
        const itemId = readStringField(item, 'id')
        if (itemId !== undefined && isBitsentryMcpToolItem(item)) {
          bitsentryMcpToolItemIds.add(itemId)
        }
        const itemType = readStringField(item, 'type')
        if (itemType === 'agentMessage' && output.trim().length > 0) {
          pendingAssistantMessageBreak = true
        }
        break
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta':
      case 'item/commandExecution/terminalInteraction':
      case 'item/fileChange/outputDelta': {
        for (const delta of codexStreamDeltasFromNotification(notification.method, params)) {
          options.onDelta?.(delta)
        }
        break
      }

      case 'turn/completed':
      case 'thread/completed': {
        activeTurnId = undefined
        options.onDelta?.({ type: 'status', status: 'completed' })
        break
      }

      case 'turn/error':
      case 'thread/error': {
        const message =
          readStringField(params, 'message') ??
          readStringField(params, 'error')
        log.warn('[codex-provider] Turn/thread error:', message)
        activeTurnId = undefined
        options.onDelta?.({ type: 'status', status: 'failed' })
        break
      }

      default:
        break
    }
  })

  client.on('serverRequest', (request: { id: JsonRpcId; method: string; params: unknown }) => {
    const requestParams = asRecord(request.params)
    const itemId = readStringField(requestParams, 'itemId')
    const decision = chooseCodexApprovalResponse(
      request.method,
      request.params,
      effectiveAccessLevel,
      itemId !== undefined && bitsentryMcpToolItemIds.has(itemId),
    )
    const elicitation = request.method === CODEX_MCP_ELICITATION_METHOD
      ? summarizeCodexMcpElicitation(request.params)
      : undefined
    if (decision === undefined) {
      log.info('[codex-provider] approval decision', {
        agentSessionId: options.mcpEndpoint?.agentSessionId ?? 'unknown',
        method: request.method,
        choice: 'deny',
        ...(elicitation === undefined ? {} : { elicitation }),
      })
      client.respondToServerRequestError(request.id, 'Method not supported')
      return
    }
    log.info('[codex-provider] approval decision', {
      agentSessionId: options.mcpEndpoint?.agentSessionId ?? 'unknown',
      method: request.method,
      choice: decision.choice,
      itemId: itemId ?? null,
      responsePayloadKeys: Object.keys(decision.result).sort(),
      ...(elicitation === undefined ? {} : {
        elicitation: {
          ...elicitation,
          serverScopedHostApproval: isBitsentryMcpToolApprovalElicitation(request.params),
        },
      }),
    })
    client.respondToServerRequest(request.id, decision.result)
  })

  try {
    options.onDelta?.({ type: 'status', status: 'started' })

    await client.start()

    const mcpEndpoint = options.mcpEndpoint
    const incidentInstructions = mcpEndpoint === undefined
      ? undefined
      : [
          options.systemPrompt,
          buildRunbookOnlyScope({
            includeProposalInstructions: mcpEndpoint.hasRunbookProposal === true,
            includeToolFailureInstructions: mcpEndpoint.hasRunbookToolFailure === true,
            includeParameterInstructions: mcpEndpoint.hasRunbookParameters === true,
            includeMultiRunbookInstructions: mcpEndpoint.hasMultipleRunbooksInPlay === true,
          }),
        ].filter((instruction): instruction is string =>
          instruction !== undefined && instruction.trim().length > 0,
        ).join('\n\n')
    const threadConfig = mcpEndpoint === undefined
      ? undefined
      : {
          include_permissions_instructions: false,
          include_apps_instructions: false,
          include_collaboration_mode_instructions: false,
          project_doc_max_bytes: 0,
          features: { apps: false, plugins: false },
          skills: { include_instructions: false },
          mcp_servers: {
            bitsentry: {
              command: mcpEndpoint.command,
              args: mcpEndpoint.args,
              env: mcpEndpoint.env,
            },
          },
        }
    if (threadConfig !== undefined && mcpEndpoint !== undefined) {
      const configuredHostTools = getHostTools()
      log.info('[codex-provider] configured host tools', {
        agentSessionId: mcpEndpoint.agentSessionId,
        toolNames: configuredHostTools.map((hostTool) => hostTool.name),
      })
    }
    const threadResult = asRecord(await client.sendRequest('thread/start', {
      cwd,
      ...(threadConfig === undefined ? {} : { config: threadConfig }),
      ...(incidentInstructions === undefined
        ? {}
        : {
            baseInstructions: incidentInstructions,
            developerInstructions: '',
          }),
    }))
    const thread = asRecord(threadResult?.thread)
    threadId =
      readStringField(thread, 'id') ??
      readStringField(threadResult, 'threadId') ??
      threadId

    // Register completion listener BEFORE starting the turn to avoid missing
    // events that arrive back-to-back with the turn/start response.
    // Suppress unhandled rejection if turn/start fails before we await this.
    const turnCompletion = new Promise<void>((resolve, reject) => {
      const onNotification = (notification: { method: string; params: unknown }) => {
        if (
          notification.method === 'turn/completed' ||
          notification.method === 'thread/completed'
        ) {
          client.removeListener('notification', onNotification)
          client.removeListener('closed', onClosed)
          // A turn can "complete" in a failed state (for example a 400 from
          // the model endpoint). Treating that as success silently drops the
          // provider's error and yields an empty result.
          const turn = asRecord(asRecord(notification.params)?.turn)
          const turnStatus = readStringField(turn, 'status')
          if (turnStatus === 'failed') {
            const turnError = asRecord(turn?.error)
            const message =
              readStringField(turnError, 'message') ?? 'Codex turn failed'
            reject(new Error(message))
            return
          }
          resolve()
        } else if (
          notification.method === 'turn/error' ||
          notification.method === 'thread/error'
        ) {
          client.removeListener('notification', onNotification)
          client.removeListener('closed', onClosed)
          const params = asRecord(notification.params)
          const message =
            readStringField(params, 'message') ??
            readStringField(params, 'error') ??
            'Codex turn failed'
          reject(new Error(message))
        }
      }

      const onClosed = (reason: string) => {
        client.removeListener('notification', onNotification)
        if (options.abortController.signal.aborted) {
          resolve()
        } else {
          reject(new Error(`Codex app-server closed: ${reason}`))
        }
      }

      client.on('notification', onNotification)
      client.once('closed', onClosed)
    })
    // Guard against unhandled rejection if turn/start throws before we await
    turnCompletion.catch(() => {})

    const policies = getCodexPolicies(effectiveAccessLevel)
    const effortValue = options.traitValues?.effort
    const prompt = options.mcpEndpoint === undefined && options.systemPrompt?.trim()
      ? [options.systemPrompt, options.prompt].join('\n\n')
      : options.prompt
    const turnStartPayload: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      approvalPolicy: policies.approvalPolicy,
      sandboxPolicy: policies.sandboxPolicy,
    }
    if (typeof effortValue === 'string' && effortValue.length > 0) {
      turnStartPayload.model_params = { reasoning: { effort: effortValue } }
    }
    const turnResult = asRecord(await client.sendRequest('turn/start', turnStartPayload))
    const turn = asRecord(turnResult?.turn)
    activeTurnId =
      readStringField(turn, 'id') ??
      readStringField(turnResult, 'turnId')

    // Wait for turn completion
    await turnCompletion
    if (tokenUsage === undefined) {
      await Promise.race([
        tokenUsageSeen,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ])
    }
  } catch (err: unknown) {
    if (isAbortSignalAborted(options.abortController.signal)) {
      options.onDelta?.({ type: 'status', status: 'cancelled' })
    } else {
      const normalizedError = normalizeCodexExecutionError(err)
      log.error('[codex-provider] Execution error:', normalizedError)
      options.onDelta?.({ type: 'status', status: 'failed' })
      throw normalizedError
    }
  } finally {
    options.abortController.signal.removeEventListener('abort', onAbort)
    const stderrTail = client.getStderrTail().trim()
    if (stderrTail.length > 0) {
      log.warn('[codex-provider] subprocess stderr tail', {
        agentSessionId: options.mcpEndpoint?.agentSessionId ?? 'unknown',
        stderrTail,
      })
    }
    await client.kill()
    await isolatedHome?.dispose()
    if (scratchDirectory !== undefined) await rm(scratchDirectory, { recursive: true, force: true })
  }

  let error: string | undefined
  if (output.trim().length === 0) {
    // Codex reports startup and config failures on stderr and then exits
    // without ever sending an assistant message. Without this the caller only
    // sees an empty string and cannot tell a refusal from a silent model.
    const stderrTail = client.getStderrTail().trim()
    if (stderrTail.length > 0) {
      error = stderrTail
    }
  }

  return {
    output,
    threadId,
    tokenUsage,
    error,
  }
}
