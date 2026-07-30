import {
  executeClaudeCode as executeSharedClaudeCode,
  type ClaudeCodeExecutionOptions,
} from './claude-code-provider.service.js'
import {
  registerCodingAgentsHandlers,
  unregisterCodingAgentsHandlers,
  type CodingAgentsHandlerProvider,
  type CodingAgentsIpcMain,
} from './coding-agents.handlers.js'
import {
  CodingAgentsProviderService as SharedCodingAgentsProviderService,
  type CodingAgentsDebugRecorder,
  type CodingAgentsErrorContext,
  type CodingAgentsSettingsStore,
} from './coding-agents-provider.service.js'
import {
  executeCodex as executeSharedCodex,
  type CodexDebugRecorder,
  type CodexExecutionOptions,
} from './codex-provider.service.js'
import {
  executeOpenCode as executeSharedOpenCode,
  type OpenCodeDebugRecorder,
  type OpenCodeExecutionOptions,
} from './opencode-provider.service.js'

type DesktopLogger = {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}

type DesktopBreadcrumbData = Record<string, string | number | boolean | null>

export type DesktopCodingAgentBindingsOptions = {
  log: DesktopLogger
  addBreadcrumb(category: string, message: string, data: DesktopBreadcrumbData): void
  captureMessage(message: string, level: string): void
  captureException(error: unknown, context: CodingAgentsErrorContext): void
  env?: NodeJS.ProcessEnv
}

function isTruthyEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = (env[name] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function sanitizeDebugData(
  data: Record<string, unknown>,
): DesktopBreadcrumbData {
  return Object.fromEntries(
    Object.entries(data).flatMap(([key, value]) => {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        return [[key, value] as const]
      }

      return []
    }),
  )
}

export function createDesktopCodingAgentBindings(
  options: DesktopCodingAgentBindingsOptions,
): {
  isCodingAgentDebugEnabled(): boolean
  isLocalCodingAgentDeltaStreamingEnabled(): boolean
  recordCodingAgentDebugEvent(stage: string, data: Record<string, unknown>): void
  recordCodingAgentDebugAnomaly(stage: string, data: Record<string, unknown>): void
  executeClaudeCode(options: ClaudeCodeExecutionOptions): ReturnType<typeof executeSharedClaudeCode>
  executeCodex(options: CodexExecutionOptions): ReturnType<typeof executeSharedCodex>
  executeOpenCode(options: OpenCodeExecutionOptions): ReturnType<typeof executeSharedOpenCode>
  CodingAgentsProviderService: new (
    db: CodingAgentsSettingsStore,
  ) => SharedCodingAgentsProviderService
  registerDesktopCodingAgentsHandlers(
    ipcMain: CodingAgentsIpcMain,
    localAiProvider: CodingAgentsHandlerProvider,
  ): void
  unregisterDesktopCodingAgentsHandlers(ipcMain: CodingAgentsIpcMain): void
} {
  const env = options.env ?? process.env

  function isCodingAgentDebugEnabled(): boolean {
    return isTruthyEnvFlag(env, 'BITSENTRY_ENABLE_CODING_AGENT_DEBUG')
  }

  function isLocalCodingAgentDeltaStreamingEnabled(): boolean {
    return isTruthyEnvFlag(env, 'BITSENTRY_ENABLE_LOCAL_AGENT_DELTAS')
  }

  function recordCodingAgentDebugEvent(
    stage: string,
    data: Record<string, unknown>,
  ): void {
    if (!isCodingAgentDebugEnabled()) {
      return
    }

    const sanitized = sanitizeDebugData(data)
    options.log.info('[coding-agent-debug]', stage, sanitized)
    options.addBreadcrumb('coding-agent.debug', stage, sanitized)
  }

  function recordCodingAgentDebugAnomaly(
    stage: string,
    data: Record<string, unknown>,
  ): void {
    if (!isCodingAgentDebugEnabled()) {
      return
    }

    const sanitized = sanitizeDebugData(data)
    options.log.warn('[coding-agent-debug]', stage, sanitized)
    options.addBreadcrumb('coding-agent.debug', stage, sanitized)
    options.captureMessage(`coding-agent-debug:${stage}`, 'warning')
  }

  const debugRecorder: CodingAgentsDebugRecorder = {
    recordEvent: recordCodingAgentDebugEvent,
    recordAnomaly: recordCodingAgentDebugAnomaly,
  }

  const codexDebugRecorder: CodexDebugRecorder = debugRecorder
  const openCodeDebugRecorder: OpenCodeDebugRecorder = debugRecorder

  async function executeClaudeCode(
    input: ClaudeCodeExecutionOptions,
  ): ReturnType<typeof executeSharedClaudeCode> {
    return executeSharedClaudeCode({
      ...input,
      debug: input.debug ?? debugRecorder,
    })
  }

  async function executeCodex(
    input: CodexExecutionOptions,
  ): ReturnType<typeof executeSharedCodex> {
    return executeSharedCodex({
      ...input,
      debug: input.debug ?? codexDebugRecorder,
    })
  }

  async function executeOpenCode(
    input: OpenCodeExecutionOptions,
  ): ReturnType<typeof executeSharedOpenCode> {
    return executeSharedOpenCode({
      ...input,
      debug: input.debug ?? openCodeDebugRecorder,
    })
  }

  class CodingAgentsProviderService extends SharedCodingAgentsProviderService {
    constructor(db: CodingAgentsSettingsStore) {
      super(db, {
        executeOpenCode,
        reportError(error, context) {
          options.captureException(error, context)
        },
        debugRecorder,
      })
    }
  }

  return {
    isCodingAgentDebugEnabled,
    isLocalCodingAgentDeltaStreamingEnabled,
    recordCodingAgentDebugEvent,
    recordCodingAgentDebugAnomaly,
    executeClaudeCode,
    executeCodex,
    executeOpenCode,
    CodingAgentsProviderService,
    registerDesktopCodingAgentsHandlers(ipcMain, localAiProvider) {
      registerCodingAgentsHandlers(ipcMain, localAiProvider)
    },
    unregisterDesktopCodingAgentsHandlers(ipcMain) {
      unregisterCodingAgentsHandlers(ipcMain)
    },
  }
}
