import type { AgentThreadSnapshot } from '../chat/types'
import type {
  AuthSessionState,
  BitsentryServicePorts,
  CreateErrorSourceInput,
  ErrorSourceRow,
  ErrorSourceSyncResult,
  PluginActionExecutionResult,
  PluginDescriptor,
  UpdateErrorSourceInput,
  GlobalVariable,
  GlobalVariableInput,
  GlobalVariablePatch,
  LLMProviderDto,
  LogLevelThreshold,
  RunbookActionRecord,
  RunbookExportArtifactV1,
  RunbookImportOptions,
  RunbookImportSummary,
  RunbookContextV1,
  RunbookExecutionRecord,
  RunbookExecutionSummaryRecord,
  RunbookTriggerContext,
  RunbookRecord,
  RunbookResultRecord,
  AgentEvent,
  AgentSendRequest,
  AgentSessionStatus,
  AgentStartRequest,
} from './contracts'
import type {
  AllSettingsDto,
  GeneralSettingsDto,
  NotificationSettingsDto,
  SecurityPolicyDto,
} from '../types/api.types'

export type DesktopIpcInvoke = <T = unknown>(
  channel: string,
  payload?: unknown,
) => Promise<T>

type DesktopProviderConfig = {
  baseUrl: string
  hasApiKey: boolean
  model: string
  availableModels?: string[]
  isPrimary: boolean
  isSelectable: boolean
}

type DesktopLocalBridge = {
  llm: {
    getProviders: () => Promise<Record<string, DesktopProviderConfig>>
  }
  runbooks: {
    onExecutionEvent: (
      handler: (data: {
        resultId: string
        executionId: string
        incidentThreadId?: string | null
        execution: RunbookExecutionRecord
      }) => void,
    ) => () => void
  }
  agent: {
    start: (input: AgentStartRequest) => Promise<{ sessionId: string }>
    send: (input: AgentSendRequest) => Promise<{ sessionId: string }>
    cancel: (sessionId: string) => Promise<void>
    getStatus: (sessionId: string) => Promise<AgentSessionStatus | null>
    getSnapshot: (sessionId: string) => Promise<AgentThreadSnapshot | null>
    onEvent: (
      handler: (data: {
        sessionId: string
        event: AgentEvent
        snapshot?: AgentThreadSnapshot
      }) => void,
    ) => () => void
  }
}

let desktopAuthSession: AuthSessionState = {
  user: {
    id: 1,
    email: 'local-operator@desktop',
    firstName: 'Local',
    lastName: 'Operator',
    role: { id: 1, name: 'operator' },
    status: { id: 1, name: 'active' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    totpEnabled: false,
    passkeyEnabled: false,
  },
  isAuthenticated: true,
  isLoading: false,
}

let networkOnline = true
if (typeof navigator !== 'undefined') {
  networkOnline = navigator.onLine
}
let bridgeReachable = true
let connectionMonitorStarted = false
let connectionStatusIpcInvoke: DesktopIpcInvoke | null = null

const CONNECTION_EVENT_NAME = 'bitsentry:connection-status'

function getDesktopBridge(): DesktopLocalBridge {
  if (typeof window === 'undefined') {
    throw new Error('Desktop bridge is unavailable outside the browser.')
  }

  const bridge = (window as { bitsentry?: unknown }).bitsentry as
    | DesktopLocalBridge
    | undefined

  if (bridge === undefined) {
    throw new Error('Desktop bridge is unavailable.')
  }

  return bridge
}

function dispatchConnectionEvent(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(CONNECTION_EVENT_NAME, {
      detail: {
        online: getDesktopConnectionStatus(),
        networkOnline,
        bridgeReachable,
      },
    }),
  )
}

async function probeBridgeReachability(): Promise<void> {
  if (connectionStatusIpcInvoke === null) return

  try {
    await connectionStatusIpcInvoke('settings:getGeneral')
    if (!bridgeReachable) {
      bridgeReachable = true
      dispatchConnectionEvent()
    }
  } catch {
    if (bridgeReachable) {
      bridgeReachable = false
      dispatchConnectionEvent()
    }
  }
}

function ensureConnectionMonitor(ipcInvoke: DesktopIpcInvoke): void {
  connectionStatusIpcInvoke = ipcInvoke

  if (connectionMonitorStarted || typeof window === 'undefined') return

  connectionMonitorStarted = true

  window.addEventListener('online', () => {
    networkOnline = true
    dispatchConnectionEvent()
    void probeBridgeReachability()
  })

  window.addEventListener('offline', () => {
    networkOnline = false
    dispatchConnectionEvent()
  })

  void probeBridgeReachability()
  window.setInterval(() => {
    void probeBridgeReachability()
  }, 30_000)
}

export function getDesktopConnectionStatus(): boolean {
  return networkOnline && bridgeReachable
}

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${String(Date.now())}-${Math.random().toString(36).slice(2)}`
}

function readLocalRunbookResults(): RunbookResultRecord[] {
  try {
    const raw =
      localStorage.getItem('bitsentry_results') ??
      localStorage.getItem('bitsentry_investigations')
    if (raw === null || raw.length === 0) {
      return []
    }

    return JSON.parse(raw) as RunbookResultRecord[]
  } catch {
    return []
  }
}

function toRunbookExecutionSummary(
  result: RunbookResultRecord,
): RunbookExecutionSummaryRecord {
  return {
    executionId: result.executionId ?? result.id,
    runbookId: result.runbookId,
    incidentThreadId: result.incidentThreadId ?? null,
    runbookTitle: result.runbookTitle,
    status: result.status,
    snapshotVersion: 0,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    completionReason: result.completionReason,
    stepCount: 0,
    completedStepCount: 0,
  }
}

function toSortableRunbookAction(
  action: RunbookActionRecord,
  sortOrder: number | undefined,
): RunbookActionRecord & { sortOrder?: number } {
  if (sortOrder === undefined) {
    return action
  }

  return {
    ...action,
    sortOrder,
  }
}

export function createDesktopLocalBitsentryServices({
  ipcInvoke,
}: {
  ipcInvoke: DesktopIpcInvoke
}): BitsentryServicePorts {
  ensureConnectionMonitor(ipcInvoke)

  const errorSourcesService = {
    async getAll(): Promise<ErrorSourceRow[]> {
      const response = await ipcInvoke<{ data: ErrorSourceRow[] }>('errorSources:getAll', {})
      if (Array.isArray(response.data)) {
        return response.data
      }

      return []
    },
    async create(input: CreateErrorSourceInput): Promise<ErrorSourceRow> {
      return ipcInvoke<ErrorSourceRow>('errorSources:create', input)
    },
    async update(input: UpdateErrorSourceInput): Promise<void> {
      await ipcInvoke('errorSources:update', input)
    },
    async delete(id: string): Promise<void> {
      await ipcInvoke('errorSources:delete', { id })
    },
    async sync(
      id: string,
      options: { logLevelThreshold: LogLevelThreshold; syncEnabled: boolean },
    ): Promise<ErrorSourceSyncResult> {
      await ipcInvoke('errorSources:update', { id, ...options })
      return ipcInvoke<ErrorSourceSyncResult>('errorSources:triggerSync', { id })
    },
  }

  const pluginsService = {
    async list(): Promise<PluginDescriptor[]> {
      const response = await ipcInvoke<{ data: PluginDescriptor[] }>('plugins:list', {})
      if (Array.isArray(response.data)) {
        return response.data
      }

      return []
    },
    async get(pluginId: string): Promise<PluginDescriptor | null> {
      return ipcInvoke<PluginDescriptor | null>('plugins:get', { pluginId })
    },
    async getStoredAuth(pluginId: string): Promise<Record<string, unknown>> {
      return ipcInvoke<Record<string, unknown>>('plugins:getStoredAuth', { pluginId })
    },
    async updateStoredAuth(
      pluginId: string,
      auth: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return ipcInvoke<Record<string, unknown>>('plugins:updateStoredAuth', {
        pluginId,
        auth,
      })
    },
    async clearStoredAuth(pluginId: string): Promise<void> {
      await ipcInvoke('plugins:clearStoredAuth', { pluginId })
    },
    async execute(input: {
      pluginId: string
      actionId: string
      auth?: Record<string, unknown>
      input?: Record<string, unknown>
    }): Promise<PluginActionExecutionResult> {
      return ipcInvoke<PluginActionExecutionResult>('plugins:execute', input)
    },
  }

  return {
    settings: {
      async getSystemSettings() {
        const response = await ipcInvoke<GeneralSettingsDto>('settings:getGeneral')
        return {
          ...response,
          systemTimezone: response.timezone,
        }
      },
      async getSecuritySettings() {
        return ipcInvoke<SecurityPolicyDto>('settings:getSecurity')
      },
      async getIntegrationSettings() {
        return ipcInvoke<AllSettingsDto>('settings:getAll')
      },
      async updateSystemSettings(data) {
        return ipcInvoke<GeneralSettingsDto>('settings:updateGeneral', { data, userId: 1 })
      },
      async updateSecuritySettings(data) {
        return ipcInvoke<SecurityPolicyDto>('settings:updateSecurity', { data, userId: 1 })
      },
      async updateNotificationSettings(data) {
        return ipcInvoke<NotificationSettingsDto>('settings:updateNotifications', { data, userId: 1 })
      },
    },

    globalVariables: {
      async list(): Promise<GlobalVariable[]> {
        return ipcInvoke<GlobalVariable[]>('globals:list', {})
      },
      async create(input: GlobalVariableInput): Promise<GlobalVariable> {
        return ipcInvoke<GlobalVariable>('globals:create', input)
      },
      async update(id: string, patch: GlobalVariablePatch): Promise<GlobalVariable | null> {
        return ipcInvoke<GlobalVariable | null>('globals:update', { id, patch })
      },
      async delete(id: string): Promise<{ deleted: boolean }> {
        return ipcInvoke<{ deleted: boolean }>('globals:delete', { id })
      },
    },

    errorSources: errorSourcesService,
    plugins: pluginsService,

    llmProviders: {
      async listProviders(): Promise<LLMProviderDto[]> {
        const providers = await getDesktopBridge().llm.getProviders()
        const displayNames: Record<string, string> = {
          groq: 'Groq',
          kilocode: 'KiloCode',
          openai: 'OpenAI',
          anthropic: 'Anthropic',
          gemini: 'Gemini',
          openrouter: 'OpenRouter',
          claude_code: 'Claude Code',
          codex: 'Codex',
          opencode: 'OpenCode',
        }
        const providerTypes: Record<string, LLMProviderDto['providerType']> = {
          groq: 'third_party',
          kilocode: 'third_party',
          openai: 'research_lab',
          anthropic: 'research_lab',
          gemini: 'research_lab',
          openrouter: 'third_party',
          claude_code: 'research_lab',
          codex: 'research_lab',
          opencode: 'research_lab',
        }

        const apiProviders = Object.entries(providers).map(([providerKey, config]) => {
          let model: string | null = null
          if (config.model.length > 0) {
            model = config.model
          }

          let availableModels: string[] = []
          if (Array.isArray(config.availableModels)) {
            availableModels = config.availableModels
          }

          return {
            id: providerKey,
            providerKey: providerKey as LLMProviderDto['providerKey'],
            displayName: displayNames[providerKey] ?? providerKey,
            providerType: providerTypes[providerKey] ?? 'third_party',
            baseUrl: config.baseUrl,
            hasApiKey: config.hasApiKey,
            model,
            availableModels,
            isPrimary: config.isPrimary,
            isSelectable: config.isSelectable,
            lastTestedAt: null,
            testStatus: null,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          }
        })

        // CLI providers (Claude Code, Codex) are only available in the runbook editor
        // via the IPC getProviders handler, not in shared surfaces like incident chat.
        return apiProviders
      },
      saveProvider() {
        return Promise.reject(new Error('LLM provider updates are handled in desktop settings.'))
      },
      setPrimaryProvider() {
        return Promise.reject(new Error('LLM provider updates are handled in desktop settings.'))
      },
      listModels() {
        return Promise.reject(new Error('LLM provider updates are handled in desktop settings.'))
      },
      testConnection() {
        return Promise.reject(new Error('LLM provider updates are handled in desktop settings.'))
      },
      deleteProvider() {
        return Promise.reject(new Error('LLM provider updates are handled in desktop settings.'))
      },
    },

    runbooks: {
      async list(): Promise<RunbookRecord[]> {
        return ipcInvoke<RunbookRecord[]>('runbooks:list', {})
      },
      async get(id: string): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord | null>('runbooks:get', { id })
      },
      async create(input: {
        id?: string
        title?: string
        description?: string
        actions?: Omit<RunbookActionRecord, 'id'>[]
        idleTimeout?: number
      }): Promise<RunbookRecord> {
        const created = await ipcInvoke<RunbookRecord>('runbooks:create', {
          id: input.id ?? createClientId(),
          title: input.title ?? 'Untitled runbook',
          description: input.description ?? '',
          idleTimeout: input.idleTimeout,
        })

        if (input.actions === undefined || input.actions.length === 0) {
          return created
        }

        return (await this.updateActions(created.id, input.actions)) ?? created
      },
      async updateMetadata(
        id: string,
        metadata: { title?: string; description?: string; idleTimeout?: number },
      ): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord>('runbooks:updateMeta', { id, ...metadata })
      },
      async updateActions(
        id: string,
        actions: Omit<RunbookActionRecord, 'id'>[],
      ): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord>('runbooks:updateActions', {
          runbookId: id,
          actions,
        })
      },
      async saveAction(
        id: string,
        action: RunbookActionRecord,
        sortOrder?: number,
      ): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord>('runbooks:saveAction', {
          runbookId: id,
          action: toSortableRunbookAction(action, sortOrder),
        })
      },
      async deleteAction(
        id: string,
        actionId: string,
      ): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord>('runbooks:deleteAction', {
          runbookId: id,
          actionId,
        })
      },
      async reorderActions(
        id: string,
        actionIdsInOrder: string[],
      ): Promise<RunbookRecord | null> {
        return ipcInvoke<RunbookRecord>('runbooks:reorderActions', {
          runbookId: id,
          actionIdsInOrder,
        })
      },
      async delete(id: string): Promise<{ deleted: boolean }> {
        await ipcInvoke('runbooks:delete', { id })
        return { deleted: true }
      },
      async exportContext(id: string): Promise<RunbookContextV1> {
        return ipcInvoke<RunbookContextV1>('runbooks:exportContext', { id })
      },
      async exportRunbooks(input: {
        ids: string[]
        includeGlobals?: boolean
      }): Promise<RunbookExportArtifactV1> {
        return ipcInvoke<RunbookExportArtifactV1>('runbooks:export', input)
      },
      async importRunbooks(input: {
        artifact: RunbookExportArtifactV1
        options?: RunbookImportOptions
      }): Promise<RunbookImportSummary> {
        return ipcInvoke<RunbookImportSummary>('runbooks:import', input)
      },
      listTelemetryNeeds() {
        return Promise.resolve([])
      },
      async execute(input: {
        runbookId: string
        parameterValues?: Record<string, string>
        incidentThreadId?: string
        accessLevel?: AgentStartRequest['accessLevel']
        triggerContext?: RunbookTriggerContext
      }): Promise<{ executionId: string; resultId: string }> {
        return ipcInvoke<{ executionId: string; resultId: string }>('runbooks:execute', input)
      },
      continueDiagnosis(): Promise<{ executionId: string; resultId: string }> {
        return Promise.reject(
          new Error('Continuing diagnosis runbooks is not available in desktop local mode.'),
        )
      },
      async getExecution(executionId: string): Promise<RunbookExecutionRecord | null> {
        return ipcInvoke<RunbookExecutionRecord | null>('runbooks:getExecution', { executionId })
      },
      listExecutions(filters = {}) {
        const results = readLocalRunbookResults()
        const filtered = results
          .filter((result) => filters.status === undefined || result.status === filters.status)
          .filter((result) => filters.runbookId === undefined || result.runbookId === filters.runbookId)
          .sort((left, right) =>
            new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
          )

        const offset = filters.offset ?? 0
        const limit = filters.limit ?? 50
        const page = filtered.slice(offset, offset + limit)

        return Promise.resolve({
          executions: page.map(toRunbookExecutionSummary),
          total: filtered.length,
          hasMore: offset + limit < filtered.length,
        })
      },
      listTelemetryActivity(filters = {}) {
        return this.listExecutions(filters)
      },
      getLinkedTelemetryExecution() {
        return Promise.resolve(null)
      },
      async cancelExecution(executionId: string): Promise<{ cancelled: boolean }> {
        await ipcInvoke('runbooks:cancelExecution', { executionId })
        return { cancelled: true }
      },
      onExecutionEvent(
        handler: (data: {
          resultId: string
          executionId: string
          incidentThreadId?: string | null
          execution: RunbookExecutionRecord
        }) => void,
      ): () => void {
        return getDesktopBridge().runbooks.onExecutionEvent(handler)
      },
    },

    agent: {
      start: (input: AgentStartRequest) => getDesktopBridge().agent.start(input),
      send: (input: AgentSendRequest) => getDesktopBridge().agent.send(input),
      cancel: (sessionId: string) => getDesktopBridge().agent.cancel(sessionId),
      getStatus: (sessionId: string) => getDesktopBridge().agent.getStatus(sessionId),
      getSnapshot: (sessionId: string) => getDesktopBridge().agent.getSnapshot(sessionId),
      onEvent: (
        handler: (data: {
          sessionId: string
          event: AgentEvent
          snapshot?: AgentThreadSnapshot
        }) => void,
      ) => getDesktopBridge().agent.onEvent(handler),
    },

    runtime: {
      getAuthSession() {
        return desktopAuthSession
      },
      logout() {
        return
      },
      navigate(path: string) {
        window.location.assign(path)
      },
      getConnectionStatus() {
        return getDesktopConnectionStatus()
      },
    },
  }
}
