import os from 'os'
import log from 'electron-log'
import { CodexAppServerClient, type JsonRpcId } from './codex-app-server-client'
import type { LocalAiStreamDelta, LocalAiExecutionResult } from './types'
import {
  getCodexPolicies,
  normalizeAccessLevel,
  type AccessLevel,
  DEFAULT_ACCESS_LEVEL,
} from './composer'
import { getErrorMessage } from '@bitsentry-ce/core'

type LocalAiTextStreamDelta = LocalAiStreamDelta & { type: 'text'; text?: string }

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
  onDelta?: (delta: LocalAiStreamDelta) => void
  debug?: CodexDebugRecorder
}

const PROMPT_ONLY_ALLOWED_ITEM_TYPES = new Set([
  'agentMessage',
  'userMessage',
  'reasoning',
  'agent_reasoning',
  'plan',
  'Plan',
])

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
  const isConfigLoadError =
    message.includes('failed to load configuration:') &&
    message.includes('config.toml')

  if (!isConfigLoadError) {
    if (err instanceof Error) return err
    return new Error(message)
  }

  let hint = 'Update your Codex config to use supported values.'
  if (message.includes('expected `fast` or `flex`')) {
    hint = 'Set `service_tier` in your Codex config to `flex` or `fast`.'
  }

  return new Error(`Codex configuration error: ${message}\n${hint}`)
}

export async function executeCodex(
  options: CodexExecutionOptions,
): Promise<LocalAiExecutionResult> {
  const debug = options.debug
  const cwd = options.cwd ?? os.tmpdir()
  const codexArgs = [...(options.codexArgs ?? [])]
  if (
    options.model !== undefined &&
    options.model.length > 0 &&
    !codexArgs.some((arg) => arg === '--model' || arg.startsWith('--model='))
  ) {
    codexArgs.push('--model', options.model)
  }
  let effectiveCodexArgs: string[] | undefined
  if (codexArgs.length > 0) {
    effectiveCodexArgs = codexArgs
  }
  const client = new CodexAppServerClient(options.binaryPath, cwd, effectiveCodexArgs)

  const MAX_OUTPUT_LENGTH = 50_000
  let output = ''
  let threadId: string | undefined
  let activeTurnId: string | undefined
  let promptOnlyViolation: Error | undefined
  let tokenUsage: LocalAiExecutionResult['tokenUsage']
  let pendingAssistantMessageBreak = false
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
      !/[\s\n]$/.test(output)
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

  if (isAbortSignalAborted(options.abortController.signal)) {
    return { output: '', exitCode: -1 }
  }

  options.abortController.signal.addEventListener('abort', onAbort, { once: true })

  const effectiveAccessLevel = normalizeAccessLevel(
    options.accessLevel ?? DEFAULT_ACCESS_LEVEL,
  )
  const isPromptOnly = effectiveAccessLevel === 'supervised'
  const isAutoAcceptEdits = effectiveAccessLevel === 'auto-accept-edits'
  const isFullAccess = effectiveAccessLevel === 'full-access'

  const failForPromptOnlyViolation = (method: string): void => {
    if (!isPromptOnly || promptOnlyViolation !== undefined) return

    promptOnlyViolation = new Error(`Codex attempted ${method} during prompt-only mode`)
    log.warn('[codex-provider] Prompt-only violation:', method)
    options.onDelta?.({ type: 'status', status: 'failed' })

    if (threadId !== undefined && activeTurnId !== undefined) {
      client.sendRequest('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {
        // If interrupt fails, kill below still stops the app-server.
      })
    }
    void client.kill()
  }

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
        if (finalText !== undefined && output.length === 0) {
          output = appendAssistantText(finalText).slice(0, MAX_OUTPUT_LENGTH)
          debug?.recordAnomaly('codex.completed_without_stream_deltas', {
            provider: 'codex',
            accessLevel: effectiveAccessLevel,
            threadId: threadId ?? null,
            turnId: activeTurnId ?? null,
            finalTextLength: output.length,
          })
          if (output.length > 0) {
            options.onDelta?.({ type: 'text', text: output })
          }
        }
        break
      }

      case 'item/started': {
        const item = asRecord(params?.item)
        const itemType = readStringField(item, 'type')
        if (itemType === 'agentMessage' && output.trim().length > 0) {
          pendingAssistantMessageBreak = true
        }
        if (
          itemType !== undefined &&
          !PROMPT_ONLY_ALLOWED_ITEM_TYPES.has(itemType)
        ) {
          failForPromptOnlyViolation(`item/started:${itemType}`)
        }
        break
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        for (const delta of codexStreamDeltasFromNotification(notification.method, params)) {
          options.onDelta?.(delta)
        }
        break
      }

      case 'item/commandExecution/outputDelta':
      case 'item/commandExecution/terminalInteraction':
      case 'item/fileChange/outputDelta': {
        failForPromptOnlyViolation(notification.method)
        if (!isPromptOnly) {
          for (const delta of codexStreamDeltasFromNotification(notification.method, params)) {
            options.onDelta?.(delta)
          }
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
    if (request.method === 'item/permissions/requestApproval') {
      if (isPromptOnly) {
        failForPromptOnlyViolation(request.method)
        client.respondToServerRequest(request.id, { permissions: {}, scope: 'turn' })
        return
      }
      // Codex interprets result.permissions as the granted SUBSET of the requested
      // permissions. Echoing back arbitrary requested fileSystem roots would let
      // a model widen itself beyond the active sandboxPolicy (e.g. to ~/.ssh).
      // BitSentry uses Codex as a chat/runbook assistant, not a code editor — the
      // chat path doesn't pass cwd and doesn't need to edit arbitrary local files.
      // Therefore only full-access grants permission expansions; supervised and
      // auto-accept-edits stay within their sandboxPolicy boundary.
      const params = asRecord(request.params)
      const requestedPermissions = asRecord(params?.permissions) ?? {}
      if (isFullAccess) {
        client.respondToServerRequest(request.id, { permissions: requestedPermissions, scope: 'session' })
      } else {
        client.respondToServerRequest(request.id, { permissions: {}, scope: 'turn' })
      }
    } else if (request.method.endsWith('requestApproval')) {
      if (isPromptOnly) {
        failForPromptOnlyViolation(request.method)
        client.respondToServerRequest(request.id, { decision: 'decline' })
        return
      }
      if (isFullAccess) {
        client.respondToServerRequest(request.id, { decision: 'acceptForSession' })
      } else if (isAutoAcceptEdits) {
        const isFileAction = /fileChange|fileEdit/i.test(request.method)
        let decision = 'decline'
        if (isFileAction) {
          decision = 'accept'
        }
        client.respondToServerRequest(request.id, { decision })
      } else {
        client.respondToServerRequest(request.id, { decision: 'decline' })
      }
    } else {
      client.respondToServerRequestError(request.id, 'Method not supported')
    }
  })

  try {
    options.onDelta?.({ type: 'status', status: 'started' })

    await client.start()

    const threadResult = asRecord(await client.sendRequest('thread/start', { cwd }))
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
        if (promptOnlyViolation !== undefined) {
          client.removeListener('notification', onNotification)
          client.removeListener('closed', onClosed)
          reject(promptOnlyViolation)
          return
        }

        if (
          notification.method === 'turn/completed' ||
          notification.method === 'thread/completed'
        ) {
          client.removeListener('notification', onNotification)
          client.removeListener('closed', onClosed)
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
        if (promptOnlyViolation !== undefined) {
          reject(promptOnlyViolation)
          return
        }
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
    const turnStartPayload: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: options.prompt, text_elements: [] }],
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
    await client.kill()
  }

  return {
    output,
    threadId,
    tokenUsage,
  }
}
