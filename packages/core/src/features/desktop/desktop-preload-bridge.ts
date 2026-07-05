const ELECTRON_TRPC_CHANNEL = 'electron-trpc'

type OAuthCallbackPayload = {
  url: string
  code: string | null
  state: string | null
  valid: boolean
  error?: string
  receivedAt: string
}

type NativeDialogFilter = {
  name: string
  extensions: string[]
}

type AgentSnapshot = Record<string, unknown> | null
type DesktopLocalProviderKey = 'claude_code' | 'codex' | 'opencode' | 'cursor'
type DesktopRemoteProviderKey =
  | 'groq'
  | 'kilocode'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
type AgentProviderKey = DesktopLocalProviderKey | DesktopRemoteProviderKey
type AgentLlmSelection = {
  providerKey?: AgentProviderKey
  model?: string
  thinkingEnabled?: boolean
}

type UpdaterStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

type UpdaterDisabledReasonCode =
  | 'not-packaged'
  | 'smoke-test'
  | 'unsupported-feed'

interface UpdaterState {
  status: UpdaterStatus
  appVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  downloadPercent: number | null
  checkedAt: string | null
  message: string | null
  disabledReasonCode: UpdaterDisabledReasonCode | null
}

type IpcListener = (event: unknown, payload: unknown) => void

export interface DesktopPreloadBridgePort {
  platform: string
  versions: {
    electron: string
    chrome: string
    node: string
  }
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: IpcListener): void
  removeListener(channel: string, listener: IpcListener): void
  send(channel: string, payload: unknown): void
  exposeInMainWorld(name: string, value: unknown): void
}

export interface CreateDesktopBitsentryApiOptions {
  bridge: DesktopPreloadBridgePort
  managedLlm: boolean
  agentProviderMode: 'remote' | 'local'
}

function createSubscription<T>(
  bridge: DesktopPreloadBridgePort,
  channel: string,
  callback: (payload: T) => void,
  parsePayload: (payload: unknown) => T = (payload) => payload as T,
): () => void {
  const listener: IpcListener = (_event, payload) => {
    callback(parsePayload(payload))
  }
  bridge.on(channel, listener)
  return () => {
    bridge.removeListener(channel, listener)
  }
}

function createCommonLlmBridge(bridge: DesktopPreloadBridgePort) {
  return {
    getProviders: (): Promise<
      Record<
        string,
        {
          hasApiKey: boolean
          baseUrl: string
          model: string
          availableModels: string[]
          isSelectable: boolean
          isPrimary: boolean
        }
      >
    > => {
      return bridge.invoke('bitsentry:llm:getProviders') as Promise<
        Record<
          string,
          {
            hasApiKey: boolean
            baseUrl: string
            model: string
            availableModels: string[]
            isSelectable: boolean
            isPrimary: boolean
          }
        >
      >
    },
    saveProvider: (
      providerKey: string,
      config: Record<string, unknown>,
    ): Promise<{ ok: boolean }> => {
      return bridge.invoke('bitsentry:llm:saveProvider', providerKey, config) as Promise<{ ok: boolean }>
    },
    local: {
      getSettings: (): Promise<{
        claudeCode: { enabled: boolean; binaryPath: string; lastProbe?: unknown }
        codex: { enabled: boolean; binaryPath: string; codexArgs?: string[]; lastProbe?: unknown }
        opencode: { enabled: boolean; binaryPath: string; opencodeArgs?: string[]; lastProbe?: unknown }
        cursor: { enabled: boolean; binaryPath: string; lastProbe?: unknown }
      }> => {
        return bridge.invoke('bitsentry:llm:local:getSettings') as Promise<{
          claudeCode: { enabled: boolean; binaryPath: string; lastProbe?: unknown }
          codex: { enabled: boolean; binaryPath: string; codexArgs?: string[]; lastProbe?: unknown }
          opencode: { enabled: boolean; binaryPath: string; opencodeArgs?: string[]; lastProbe?: unknown }
          cursor: { enabled: boolean; binaryPath: string; lastProbe?: unknown }
        }>
      },
      saveSettings: (patch: Record<string, unknown>): Promise<unknown> => {
        return bridge.invoke('bitsentry:llm:local:saveSettings', patch)
      },
      probe: (provider: DesktopLocalProviderKey): Promise<{
        installed: boolean
        version: string | null
        auth: { status: 'authenticated' | 'unauthenticated' | 'unknown' }
        status: 'ready' | 'error' | 'warning'
        errorKind?: string
        message?: string
      }> => {
        return bridge.invoke('bitsentry:llm:local:probe', provider) as Promise<{
          installed: boolean
          version: string | null
          auth: { status: 'authenticated' | 'unauthenticated' | 'unknown' }
          status: 'ready' | 'error' | 'warning'
          errorKind?: string
          message?: string
        }>
      },
      detectBinary: (
        provider: DesktopLocalProviderKey,
        preferredBinaryPath?: string,
      ): Promise<string | null> => {
        return bridge.invoke(
          'bitsentry:llm:local:detectBinary',
          provider,
          preferredBinaryPath,
        ) as Promise<string | null>
      },
      listModels: (provider: DesktopLocalProviderKey): Promise<string[]> => {
        return bridge.invoke('bitsentry:llm:local:listModels', provider) as Promise<string[]>
      },
      doctor: (provider: DesktopLocalProviderKey): Promise<{
        provider: string
        binaryPath: string
        probe: unknown
        resolvedPath?: string
        stderrTail?: string
      }> => {
        return bridge.invoke('bitsentry:llm:local:doctor', provider) as Promise<{
          provider: string
          binaryPath: string
          probe: unknown
          resolvedPath?: string
          stderrTail?: string
        }>
      },
    },
  }
}

function createManagedLlmBridge(bridge: DesktopPreloadBridgePort) {
  return {
    ping: (
      providerKey: string,
      config: { apiKey?: string; baseUrl?: string; model?: string; requestId?: string },
    ): Promise<{ ok: boolean; message: string; latencyMs: number; responseText: string; requestId: string }> => {
      return bridge.invoke('bitsentry:llm:ping', providerKey, config) as Promise<{
        ok: boolean
        message: string
        latencyMs: number
        responseText: string
        requestId: string
      }>
    },
    onPingProgress: (
      callback: (event: {
        requestId: string
        providerKey: string
        level: 'info' | 'chunk' | 'error' | 'done'
        message: string
        at: string
      }) => void,
    ): (() => void) => {
      return createSubscription(bridge, 'bitsentry:llm:ping:progress', callback)
    },
    clearAllCredentials: (): Promise<{ ok: boolean }> => {
      return bridge.invoke('bitsentry:llm:clearAllCredentials') as Promise<{ ok: boolean }>
    },
    listModels: (
      providerKey: string,
      config: { apiKey?: string; baseUrl?: string },
    ): Promise<{ providerKey: string; models: string[]; count: number; fetchedAt: string }> => {
      return bridge.invoke('bitsentry:llm:listModels', providerKey, config) as Promise<{
        providerKey: string
        models: string[]
        count: number
        fetchedAt: string
      }>
    },
  }
}

function createAgentBridge(
  bridge: DesktopPreloadBridgePort,
  agentProviderMode: 'remote' | 'local',
) {
  void agentProviderMode

  return {
    start: async (
      input: {
        prompt: string
        timeoutMs?: number
        attachments?: Array<{
          id: string
          type: 'image'
          name: string
          mimeType: string
          sizeBytes: number
          dataUrl: string
        }>
        llm?: AgentLlmSelection
        runbookContext?: {
          id: string
          title: string
          description: string
          actions: Array<{
            id: string
            type: string
            title: string
            command?: string
            prompt?: string
            url?: string
            method?: string
            query?: string
            body?: string
          }>
        }
      },
    ): Promise<{ sessionId: string }> => {
      return bridge.invoke('agent:start', input) as Promise<{ sessionId: string }>
    },
    send: async (
      input: {
        message: string
        sessionId?: string
        attachments?: Array<{
          id: string
          type: 'image'
          name: string
          mimeType: string
          sizeBytes: number
          dataUrl: string
        }>
        llm?: AgentLlmSelection
        runbookContext?: {
          id: string
          title: string
          description: string
          actions: Array<{
            id: string
            type: string
            title: string
            command?: string
            prompt?: string
            url?: string
            method?: string
            query?: string
            body?: string
          }>
        }
      },
    ): Promise<{ sessionId: string }> => {
      return bridge.invoke('agent:send', input) as Promise<{ sessionId: string }>
    },
    cancel: async (sessionId: string): Promise<void> => {
      await bridge.invoke('agent:cancel', { sessionId })
    },
    getStatus: async (sessionId: string): Promise<{
      sessionId: string
      state: string
      startedAt: string
      currentToolCallId: string | null
    } | null> => {
      return bridge.invoke('agent:getStatus', { sessionId }) as Promise<{
        sessionId: string
        state: string
        startedAt: string
        currentToolCallId: string | null
      } | null>
    },
    getSnapshot: async (sessionId: string): Promise<AgentSnapshot> => {
      return bridge.invoke('agent:getSnapshot', { sessionId }) as Promise<AgentSnapshot>
    },
    listRunbookAuthoringProposals: async (input: {
      sessionId?: string
      incidentThreadId?: string
    }): Promise<unknown> => {
      return bridge.invoke('agent:listRunbookAuthoringProposals', input)
    },
    approveRunbookAuthoringProposal: async (input: {
      sessionId?: string
      incidentThreadId?: string
      proposalId: string
      approvedOperationIds?: string[]
    }): Promise<unknown> => {
      return bridge.invoke('agent:approveRunbookAuthoringProposal', input)
    },
    rejectRunbookAuthoringProposal: async (input: {
      sessionId?: string
      incidentThreadId?: string
      proposalId: string
      reason?: string
    }): Promise<unknown> => {
      return bridge.invoke('agent:rejectRunbookAuthoringProposal', input)
    },
    requestRunbookAuthoringRevision: async (input: {
      sessionId?: string
      incidentThreadId?: string
      proposalId: string
      requestedEdit: string
    }): Promise<unknown> => {
      return bridge.invoke('agent:requestRunbookAuthoringRevision', input)
    },
    onEvent: (
      callback: (event: {
        sessionId: string
        event: {
          type: string
          timestamp: string
          [key: string]: unknown
        }
        snapshot?: Record<string, unknown>
      }) => void,
    ): (() => void) => {
      return createSubscription(bridge, 'bitsentry:agent:event', callback)
    },
  }
}

export function createDesktopBitsentryApi({
  bridge,
  managedLlm,
  agentProviderMode,
}: CreateDesktopBitsentryApiOptions) {
  const llm = createCommonLlmBridge(bridge)
  if (managedLlm) {
    Object.assign(llm, createManagedLlmBridge(bridge))
  }

  return {
    platform: {
      os: bridge.platform,
      getVersions: () => ({
        electron: bridge.versions.electron,
        chrome: bridge.versions.chrome,
        node: bridge.versions.node,
      }),
    },
    llm,
    sentry: {
      isEnabled: (): Promise<boolean> => {
        return bridge.invoke('bitsentry:sentry:isEnabled') as Promise<boolean>
      },
      setEnabled: (enabled: boolean): Promise<{ ok: boolean }> => {
        return bridge.invoke('bitsentry:sentry:setEnabled', enabled) as Promise<{ ok: boolean }>
      },
      rendererShouldInit: (): Promise<boolean> => {
        return bridge.invoke('bitsentry:sentry:rendererShouldInit') as Promise<boolean>
      },
    },
    analytics: {
      getContext: (): Promise<{
        installationId: string | null
        telemetryEnabled: boolean
        shouldCaptureFirstRun: boolean
        appVersion: string
        releaseChannel: string
        platform: string
      }> => {
        return bridge.invoke('bitsentry:analytics:getContext') as Promise<{
          installationId: string | null
          telemetryEnabled: boolean
          shouldCaptureFirstRun: boolean
          appVersion: string
          releaseChannel: string
          platform: string
        }>
      },
      markFirstRunCaptured: (): Promise<{ ok: boolean }> => {
        return bridge.invoke('bitsentry:analytics:markFirstRunCaptured') as Promise<{ ok: boolean }>
      },
    },
    telemetry: {
      getStatus: (): Promise<{ enabled: boolean; canDisable: boolean }> => {
        return bridge.invoke('bitsentry:telemetry:getStatus') as Promise<{ enabled: boolean; canDisable: boolean }>
      },
      setEnabled: (enabled: boolean): Promise<{ ok: boolean }> => {
        return bridge.invoke('bitsentry:telemetry:setEnabled', enabled) as Promise<{ ok: boolean }>
      },
    },
    database: {
      reset: (): Promise<{ ok: boolean }> => {
        return bridge.invoke('bitsentry:database:reset') as Promise<{ ok: boolean }>
      },
    },
    dialog: {
      showSaveDialog: (
        input?: {
          defaultPath?: string
          defaultFileName?: string
          filters?: NativeDialogFilter[]
          trustScope?: 'runbooks-export'
        },
      ): Promise<{ filePath: string | null; canceled: boolean }> => {
        return bridge.invoke('dialog:showSaveDialog', input ?? {}) as Promise<{ filePath: string | null; canceled: boolean }>
      },
      showOpenDialog: (
        input?: {
          defaultPath?: string
          filters?: NativeDialogFilter[]
          properties?: string[]
          trustScope?: 'runbooks-import'
        },
      ): Promise<{ filePaths: string[]; canceled: boolean }> => {
        return bridge.invoke('dialog:showOpenDialog', input ?? {}) as Promise<{ filePaths: string[]; canceled: boolean }>
      },
    },
    oauth: {
      onCallback: (callback: (payload: OAuthCallbackPayload) => void): (() => void) => {
        return createSubscription(bridge, 'bitsentry:oauth:callback', callback)
      },
    },
    agent: createAgentBridge(bridge, agentProviderMode),
    runbooks: {
      execute: async (input: {
        runbookId: string
        parameterValues?: Record<string, string>
        incidentThreadId?: string
        triggerContext?: {
          entrypoint: 'runbooks' | 'incident_detail' | 'incident_workspace' | 'diagnosis'
          needId?: string
          needLabel?: string
          sourceId?: string
          sourceName?: string
          sourceType?: 'sentry' | 'wazuh' | 'posthog'
          incidentThreadId?: string
        }
      }): Promise<{ executionId: string; resultId: string }> => {
        return bridge.invoke('runbooks:execute', input) as Promise<{
          executionId: string
          resultId: string
        }>
      },
      getExecution: async (
        executionId: string,
      ): Promise<Record<string, unknown> | null> => {
        return bridge.invoke('runbooks:getExecution', { executionId }) as Promise<Record<string, unknown> | null>
      },
      cancelExecution: async (executionId: string): Promise<void> => {
        await bridge.invoke('runbooks:cancelExecution', { executionId })
      },
      onExecutionEvent: (
        callback: (event: {
          resultId: string
          executionId: string
          incidentThreadId?: string | null
          execution: Record<string, unknown>
        }) => void,
      ): (() => void) => {
        return createSubscription(bridge, 'bitsentry:runbooks:execution', callback)
      },
    },
    incidents: {
      getState: async (): Promise<{
        incidents: Array<{
          id: string
          title: string
          createdAt: string
          prompt: string
          state: string
          archived?: boolean
          archivedAt?: string
          lastMessagePreview?: string | null
        }>
        incidentMessages: Record<string, unknown[]>
      }> => {
        return bridge.invoke('incidents:getState', {}) as Promise<{
          incidents: Array<{
            id: string
            title: string
            createdAt: string
            prompt: string
            state: string
            archived?: boolean
            archivedAt?: string
            lastMessagePreview?: string | null
          }>
          incidentMessages: Record<string, unknown[]>
        }>
      },
      replaceState: async (
        snapshot: {
          incidents: Array<{
            id: string
            title: string
            createdAt: string
            prompt: string
            state: string
            archived?: boolean
            archivedAt?: string
            lastMessagePreview?: string | null
          }>
          incidentMessages: Record<string, unknown[]>
        },
      ): Promise<{ ok: true; count: number }> => {
        return bridge.invoke('incidents:replaceState', snapshot) as Promise<{
          ok: true
          count: number
        }>
      },
    },
    updater: {
      getState: (): Promise<UpdaterState> => {
        return bridge.invoke('bitsentry:updater:getState') as Promise<UpdaterState>
      },
      check: (): Promise<UpdaterState> => {
        return bridge.invoke('bitsentry:updater:check') as Promise<UpdaterState>
      },
      download: (): Promise<{ accepted: boolean }> => {
        return bridge.invoke('bitsentry:updater:download') as Promise<{ accepted: boolean }>
      },
      install: (): Promise<{ accepted: boolean }> => {
        return bridge.invoke('bitsentry:updater:install') as Promise<{ accepted: boolean }>
      },
      onState: (callback: (state: UpdaterState) => void): (() => void) => {
        return createSubscription(bridge, 'bitsentry:updater:state', callback)
      },
    },
  }
}

export type DesktopBitsentryApi = ReturnType<typeof createDesktopBitsentryApi>

function exposeElectronTRPCBridge(bridge: DesktopPreloadBridgePort): void {
  bridge.exposeInMainWorld('electronTRPC', {
    sendMessage: (operation: unknown) => {
      bridge.send(ELECTRON_TRPC_CHANNEL, operation)
    },
    onMessage: (callback: (args: unknown) => void) => {
      bridge.on(ELECTRON_TRPC_CHANNEL, (_event, args) => {
        callback(args)
      })
    },
  })
}

function safeExpose(name: string, expose: () => void): void {
  try {
    expose()
  } catch (error) {
    console.error(`[preload] Failed to expose ${name}:`, error)
  }
}

export function exposeDesktopPreload(
  bridge: DesktopPreloadBridgePort,
  bitsentryApi: DesktopBitsentryApi,
): void {
  safeExpose('electronTRPC', () => {
    exposeElectronTRPCBridge(bridge)
  })

  safeExpose('bitsentry', () => {
    bridge.exposeInMainWorld('bitsentry', bitsentryApi)
  })
}
