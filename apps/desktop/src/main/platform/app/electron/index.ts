import { initSentryIfEnabled, closeSentry, setSentryEnabled, isSentryEnabled, hasSentryDsn, captureException } from '@bitsentry-ce/desktop-cli/runtime/desktop-sentry'
import {
  getDesktopAnalyticsContext,
  markDesktopFirstRunCaptured,
} from '@bitsentry-ce/desktop-cli/runtime/desktop-posthog'
import { getTelemetryStatus, setTelemetryEnabled } from '@bitsentry-ce/core/features/analytics'
import path from 'path'
import { appendFileSync, readFileSync } from 'fs'
import { rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron'
import { createIPCHandler } from 'electron-trpc/main'
import log from 'electron-log'
import MenuBuilder from './menu'
import { DesktopIpcDispatcher, createDesktopTrpcRouter } from '@bitsentry-ce/components/services'
import { getCatalogModelIds } from '@bitsentry-ce/components/llm/modelCatalog'
import {
  createDesktopElectronShell,
  createDesktopMainWindow,
  formatDesktopStartupError,
  writeDesktopStartupDiagnosticsArtifact,
} from '@bitsentry-ce/core/features/desktop/desktop-electron-shell'
import { getDesktopEditionIdentity } from '@bitsentry-ce/core/features/desktop/desktop-edition-identity'
import {
  buildDesktopLocalProviderRecords,
  getDesktopLocalPrimaryProviderKey,
  isDesktopLocalAiProviderKey,
  saveDesktopProviderSettings,
} from '@bitsentry-ce/core/features/desktop/desktop-llm-provider-settings'
import { DesktopGlobalVariablesService } from '@bitsentry-ce/core/features/runbooks'
import '../../storage/database/seeding'
import {
  initializeDatabase,
  closeDatabase,
  resetDatabase,
} from '@bitsentry-ce/desktop-cli/runtime/database-index'
import { composeServices } from '../compose-services'
import type { DesktopServices } from '../compose-services'
import { validateIpcPayload } from '../ipc/schemas'
import { createDesktopSettingsHandlers } from '@bitsentry-ce/core/features/settings'
import {
  createDesktopNodePluginRuntimeService,
  createDesktopPluginHandlers,
} from '@bitsentry-ce/core/features/plugins/node'
import { createDesktopYamlRunbookHandlers as createRunbookHandlers } from '@bitsentry-ce/core/features/runbooks/desktop-runbook-handler-yaml-bindings'
import { createDesktopStateHandlers } from '@bitsentry-ce/core/features/desktop-state/desktop-state.handlers'
import {
  approveRunbookExportPath,
  approveRunbookImportPaths,
} from '@bitsentry-ce/core/features/runbooks/desktop-trusted-runbook-paths'
import {
  createDesktopDialogHandlers,
  type DesktopDialogPort,
} from '@bitsentry-ce/core/features/runbooks/desktop-dialog.handlers'
import {
  createDesktopAgentHandlers as createAgentHandlers,
  createDesktopAgentService,
} from '@bitsentry-ce/coding-agents/agent.handlers'
import { createDesktopAgentLlmAdapter } from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'
import {
  registerCodingAgentsHandlers,
  unregisterCodingAgentsHandlers,
} from '@bitsentry-ce/coding-agents/coding-agents.handlers'
import type { LocalAiProviderKey } from '@bitsentry-ce/coding-agents'
import { ExternalSourceRunbookQueryService } from '@bitsentry-ce/core/features/error-sources'
import { SqliteRunbookResultStore } from '@bitsentry-ce/core/features/runbooks/desktop-runbook-result.store'
import { SqliteErrorSourcesRepositoryAdapter } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter'
import { createDesktopErrorSourcesHandlers } from '@bitsentry-ce/core/features/error-sources/desktop-error-sources.handlers'
import { AgentRuntimeService } from '@bitsentry-ce/desktop-cli/runtime/desktop-agent-runtime'
import { RunbookExecutionService } from '../../../features/runbooks/services/runbook-execution.service'
import { CodingAgentsProviderService } from '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
import { DesktopRunbookStore as RunbookStore } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.store'
import { OauthManagerService } from '../../../features/error-sources/services/oauth-manager.service'
import {
  DESKTOP_PROTOCOL_SCHEME,
  OAUTH_CALLBACK_CHANNEL,
  extractDeepLinkFromArgv,
  parseOAuthCallbackUrl,
  type OAuthCallbackPayload,
} from './oauth-callback'
import { getAutoUpdaterEnablement } from '@bitsentry-ce/core/features/updater/desktop-updater-policy'
import { startAutoUpdater } from '@bitsentry-ce/desktop-cli/runtime/desktop-updater'
import { LocalPluginCredentialsStore } from '@bitsentry-ce/desktop-cli/runtime/plugin-credentials-store'
import { DesktopShutdownCoordinator } from './shutdown-coordinator'

type UpdaterController = ReturnType<typeof startAutoUpdater> | null
type LocalAiProviderService = InstanceType<typeof CodingAgentsProviderService>

let services: DesktopServices | null = null
let agentRuntime: ReturnType<typeof createDesktopAgentService> | null = null
let runbookExecutionService: RunbookExecutionService | null = null
let localAiProvider: LocalAiProviderService | null = null
let updaterController: UpdaterController = null

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true'
const desktopEditionIdentity = getDesktopEditionIdentity('ce')
const APP_NAME = desktopEditionIdentity.productName
const APP_DATA_NAME = desktopEditionIdentity.appDataName
const SPLASH_TITLE = 'BitSentry'
const isSmokeTest = process.env.BITSENTRY_DESKTOP_SMOKE_TEST === '1'
const SMOKE_TEST_READY_MARKER = '[smoke] desktop-ready'
const SMOKE_RUNBOOK_COMPLETE_MARKER = '[smoke] runbook-completed'
const isRunbookSmokeScenario = process.env.BITSENTRY_DESKTOP_SMOKE_SCENARIO === 'runbook'
const smokeMarkerFilePath = process.env.BITSENTRY_DESKTOP_SMOKE_MARKER_FILE
log.transports.console.level = false
if (isDebug) {
  log.transports.console.level = 'info'
} else if (isSmokeTest) {
  log.transports.console.level = 'warn'
}
// Agent runtime will be created after services are initialized

class DesktopBrowserWindow extends BrowserWindow {
  constructor(options?: unknown) {
    super(options as BrowserWindowConstructorOptions | undefined)
  }
}

const pendingOAuthCallbacks: OAuthCallbackPayload[] = []
let rendererReadyForEvents = false
let rendererReadyPromise: Promise<void> | null = null
let resolveRendererReady: (() => void) | null = null
const desktopShell = createDesktopElectronShell({
  app,
  appName: APP_NAME,
  splashTitle: SPLASH_TITLE,
  browserWindow: DesktopBrowserWindow,
  readTextFile: (filePath) => readFileSync(filePath).toString('base64'),
  resolveResourcesPath: () => process.resourcesPath,
})

function readSettingString(setting: unknown): string {
  if (setting === null || typeof setting !== 'object' || !('value' in setting)) {
    return ''
  }

  const { value } = setting
  if (typeof value === 'string') {
    return value
  }

  return ''
}

function readReleaseChannel(): 'stable' | 'beta' | 'preview' {
  const value = process.env.BITSENTRY_RELEASE_CHANNEL
  if (value === 'beta' || value === 'preview') {
    return value
  }
  return 'stable'
}

function readPackagedAutoUpdateConfig(): string | null {
  if (!app.isPackaged) return null

  try {
    return readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
  } catch (error) {
    log.warn('[updater] Failed to read packaged app-update.yml:', error)
    return null
  }
}

function flushPendingOAuthCallbacks(): void {
  if (desktopShell.mainWindow === null || desktopShell.mainWindow.isDestroyed() || !rendererReadyForEvents) return

  while (pendingOAuthCallbacks.length > 0) {
    const payload = pendingOAuthCallbacks.shift()
    if (payload === undefined) break
    desktopShell.mainWindow.webContents.send(OAUTH_CALLBACK_CHANNEL, payload)
  }
}

function publishOAuthCallback(payload: OAuthCallbackPayload): void {
  if (desktopShell.mainWindow !== null && !desktopShell.mainWindow.isDestroyed() && rendererReadyForEvents) {
    desktopShell.mainWindow.webContents.send(OAUTH_CALLBACK_CHANNEL, payload)
    return
  }
  pendingOAuthCallbacks.push(payload)
}

function handleDeepLink(rawUrl: string, source: string): void {
  const payload = parseOAuthCallbackUrl(rawUrl)
  log.info(
    `[oauth] Received deep link via ${source}: valid=${String(payload.valid)} url=${payload.url}`,
  )
  if (!payload.valid) {
    log.warn(`[oauth] Deep link rejected: ${payload.error ?? 'unknown reason'}`)
  }

  publishOAuthCallback(payload)
}

function registerDesktopProtocolHandler(): void {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      const defaultAppEntry = process.argv[1]
      app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME, process.execPath, [
        path.resolve(defaultAppEntry),
      ])
    } else {
      app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL_SCHEME)
    }
  } catch (error) {
    log.warn('[oauth] Failed to register desktop protocol handler:', error)
  }
}

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

app.on('second-instance', (_event, argv) => {
  desktopShell.focusOpenWindow()
  const deepLink = extractDeepLinkFromArgv(argv)
  if (deepLink !== null) {
    handleDeepLink(deepLink, 'second-instance')
  }
})

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url, 'open-url')
})

// IPC dispatcher
const dispatcher = new DesktopIpcDispatcher({
  logger: log,
  captureException,
  validatePayload: validateIpcPayload,
})

const getAssetPath = desktopShell.getAssetPath
const createSplashWindow = desktopShell.createSplashWindow
const closeSplashWindow = desktopShell.closeSplashWindow
const getBrowserWindow = (): BrowserWindow | null =>
  desktopShell.mainWindow as BrowserWindow | null
const formatStartupError = formatDesktopStartupError
const writeStartupDiagnosticsArtifact = (
  desktopServices: DesktopServices,
  localDispatcher: DesktopIpcDispatcher,
) =>
  writeDesktopStartupDiagnosticsArtifact(app, desktopServices, localDispatcher).catch((error: unknown) => {
    log.warn(String(error))
  })

function waitForRendererReady(): Promise<void> {
  if (rendererReadyForEvents) {
    return Promise.resolve()
  }
  if (rendererReadyPromise === null) {
    rendererReadyPromise = new Promise<void>((resolve) => {
      resolveRendererReady = resolve
    })
  }
  return rendererReadyPromise
}

function writeSmokeMarker(marker: string): void {
  if (smokeMarkerFilePath === undefined || smokeMarkerFilePath.length === 0) return

  try {
    appendFileSync(smokeMarkerFilePath, `${marker}\n`, 'utf8')
  } catch (error) {
    log.error(`[smoke] Failed to write marker ${marker}:`, error)
  }
}

const createWindow = async () => {
  await createDesktopMainWindow({
    browserWindow: DesktopBrowserWindow,
    desktopShell,
    isDebug,
    isSmokeTest,
    autoQuitSmokeTest: !isRunbookSmokeScenario,
    smokeTestReadyMarker: SMOKE_TEST_READY_MARKER,
    onSmokeTestReady: () => {
      writeSmokeMarker(SMOKE_TEST_READY_MARKER)
    },
    preloadPath: path.join(__dirname, '../preload/index.js'),
    localRendererPath: path.join(__dirname, '../renderer/index.html'),
    installReactDevTools: async () => {
      const installer = await import('electron-devtools-installer')
      await installer.default(installer.REACT_DEVELOPER_TOOLS)
    },
    setPermissionRequestHandler: (handler) => {
      session.defaultSession.setPermissionRequestHandler(
        handler,
      )
    },
    logger: {
      info: (message) => {
        log.info(message)
      },
      warn: (message) => {
        log.warn(message)
      },
      error: (message) => {
        log.error(message)
      },
    },
    openExternal: (url) => {
      void shell.openExternal(url)
    },
    onRendererReady: () => {
      rendererReadyForEvents = true
      resolveRendererReady?.()
      resolveRendererReady = null
      flushPendingOAuthCallbacks()
    },
    onWindowClosed: () => {
      rendererReadyForEvents = false
      rendererReadyPromise = null
      resolveRendererReady = null
    },
    createMenu: (window) => {
      const menuBuilder = new MenuBuilder(window as BrowserWindow)
      menuBuilder.buildMenu()
    },
    quitApp: () => {
      app.quit()
    },
  })

  const updaterEnablement = getAutoUpdaterEnablement({
    isPackaged: app.isPackaged,
    isSmokeTest,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    releaseChannel: readReleaseChannel(),
    appUpdateConfigContents: readPackagedAutoUpdateConfig(),
  })
  log.transports.file.level = 'info'
  if (updaterController === null) {
    updaterController = startAutoUpdater({
      getWindow: getBrowserWindow,
      shouldEnable: updaterEnablement.enabled,
      disabledReasonCode: updaterEnablement.disabledReasonCode,
      feedUrl: updaterEnablement.feedUrl,
      beforeInstall: async () => {
        log.info('[updater] tearing down runtime before install...')
        try {
          agentRuntime?.destroy()
          await runbookExecutionService?.destroy()
          runbookExecutionService = null
          localAiProvider?.destroy()
          unregisterCodingAgentsHandlers(ipcMain)
          localAiProvider = null
          if (services !== null) {
            await services.jobRuntime.stop()
          }
        } catch (error) {
          log.error('[updater] teardown error (continuing with install):', error)
        }
      },
    })
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

const shutdownCoordinator = new DesktopShutdownCoordinator({
  stopUpdater: () => {
    updaterController?.stop()
    updaterController = null
  },
  destroyAgentRuntime: () => agentRuntime?.destroy(),
  destroyCodingAgents: () => {
    localAiProvider?.destroy()
    unregisterCodingAgentsHandlers(ipcMain)
    localAiProvider = null
  },
  closeSentry,
  destroyRunbookExecution: async () => {
    await runbookExecutionService?.destroy()
    runbookExecutionService = null
  },
  stopJobRuntime: async () => {
    await services?.jobRuntime.stop()
  },
  closeDatabase,
  onShutdownError: (step, error) => {
    log.error(`[main] Failed to release ${step} during shutdown`, error)
  },
})

app.on('before-quit', (event) => {
  shutdownCoordinator.handleBeforeQuit(event, () => {
    app.quit()
  })
})

app
  .whenReady()
  .then(async () => {
    // Set app name and dock icon (overrides default Electron branding in dev)
    app.setName(APP_DATA_NAME)
    if (process.platform === 'darwin' && app.dock !== undefined) {
      app.dock.setIcon(getAssetPath('icon.png'))
    }

    registerDesktopProtocolHandler()

    const launchDeepLink = extractDeepLinkFromArgv(process.argv)
    if (launchDeepLink !== null) {
      handleDeepLink(launchDeepLink, 'process.argv')
    }

    createSplashWindow()

    try {
      // Initialize database and compose services before creating window
      const db = await initializeDatabase()
      await initSentryIfEnabled(db)

      // One-time cleanup: cloud LLM providers were removed, so drop the
      // encrypted credentials file left behind by older installs.
      const legacyLlmCredentialsPath = path.join(app.getPath('userData'), 'auth', 'llm-providers.json')
      await rm(legacyLlmCredentialsPath, { force: true }).catch((error: unknown) => {
        log.warn('[main] Failed to remove legacy LLM credentials file:', error)
      })

      services = await composeServices(db)
      const desktopServices = services
      const userDataPath = app.getPath('userData')
      const pluginCredentialsStore = new LocalPluginCredentialsStore(userDataPath)
      const pluginRuntime = createDesktopNodePluginRuntimeService(
        [path.join(userDataPath, 'plugins')],
        pluginCredentialsStore,
      )

      // Register IPC handlers
      dispatcher.registerAll(
        createDesktopErrorSourcesHandlers(db, {
          OauthManagerService,
          pluginRuntime,
        }),
      )
      dispatcher.registerAll(
        createDesktopPluginHandlers(pluginRuntime, pluginCredentialsStore),
      )
      dispatcher.registerAll(createDesktopSettingsHandlers(desktopServices.settingsUseCases))
      const agentLlmAdapter = createDesktopAgentLlmAdapter(db)
      const globalVariablesService = new DesktopGlobalVariablesService(db)
      const runbookStore = new RunbookStore(db, globalVariablesService)
      const externalSourceRunbookQueryService = new ExternalSourceRunbookQueryService(
        new SqliteErrorSourcesRepositoryAdapter(db),
        undefined,
        pluginRuntime,
      )
      const runbookResultStore = new SqliteRunbookResultStore(db)
      await runbookResultStore.markStaleRunningSessionsFailed()
      localAiProvider = new CodingAgentsProviderService(db)
      await localAiProvider.loadSettings()
      registerCodingAgentsHandlers(ipcMain, localAiProvider)
      agentLlmAdapter.setLocalAiProvider(localAiProvider)

      runbookExecutionService = new RunbookExecutionService(
        runbookStore,
        globalVariablesService,
        agentLlmAdapter,
        externalSourceRunbookQueryService,
        runbookResultStore,
        () => desktopShell.mainWindow,
        undefined,
        localAiProvider,
        pluginRuntime,
      )
      dispatcher.registerAll(createRunbookHandlers(db, {
        executionService: runbookExecutionService,
        globalVariablesService,
      }, { edition: 'ce' }))
      dispatcher.registerAll(createDesktopStateHandlers(db))
      dispatcher.registerAll(
        createDesktopDialogHandlers({
          app,
          dialog: dialog,
          getWindow: () => desktopShell.mainWindow,
          approveRunbookExportPath,
          approveRunbookImportPaths,
        }),
      )

      // Create agent runtime with LLM adapter
      agentRuntime = createDesktopAgentService(
        {
          llmAdapter: agentLlmAdapter,
          runbookStore: runbookStore,
          runbookExecutionService: runbookExecutionService,
          windowGetter: () => desktopShell.mainWindow,
        },
        { AgentRuntimeService },
      )
      dispatcher.registerAll(createAgentHandlers({ agentRuntime }))

      // Register direct IPC handlers for preload bridge compatibility.
      // These forward to the dispatcher-registered handlers.
      const directBridgeChannels = [
        'agent:start',
        'agent:send',
        'agent:cancel',
        'agent:getStatus',
        'agent:getSnapshot',
        'runbooks:execute',
        'runbooks:getExecution',
        'runbooks:cancelExecution',
        'incidents:getState',
        'incidents:replaceState',
        'dialog:showSaveDialog',
        'dialog:showOpenDialog',
      ] as const
      for (const channel of directBridgeChannels) {
        ipcMain.handle(channel, async (_event, payload) => dispatcher.dispatch(channel, payload))
      }


      // Sentry telemetry opt-in IPC
      ipcMain.handle('bitsentry:sentry:isEnabled', async () => {
        return isSentryEnabled(db)
      })
      ipcMain.handle('bitsentry:sentry:setEnabled', async (_event, enabled: unknown) => {
        await setSentryEnabled(db, enabled === true)
        return { ok: true }
      })
      ipcMain.handle('bitsentry:telemetry:getStatus', async () => {
        return getTelemetryStatus(db)
      })
      ipcMain.handle('bitsentry:telemetry:setEnabled', async (_event, enabled: unknown) => {
        await setTelemetryEnabled(db, enabled === true)
        return { ok: true }
      })
      // Renderer init gate: only true when both the user has opted in AND the
      // main process actually has a DSN configured. Without a DSN, main never
      // initializes the Sentry main client, so the renderer SDK can't reach it
      // (appears as "sentry-ipc://" CSP errors or "scheme not supported").
      ipcMain.handle('bitsentry:sentry:rendererShouldInit', async () => {
        if (!hasSentryDsn()) return false
        return isSentryEnabled(db)
      })
      ipcMain.handle('bitsentry:analytics:getContext', async () => {
        return getDesktopAnalyticsContext(db)
      })
      ipcMain.handle('bitsentry:analytics:markFirstRunCaptured', async () => {
        await markDesktopFirstRunCaptured(db)
        return { ok: true }
      })

      // Initialize settings defaults after registration
      await desktopServices.settingsUseCases.initializeDefaults(1)

      const upsertSetting = async (
        key: string,
        value: string,
        type = 'string',
        description?: string,
      ): Promise<void> => {
        const now = new Date().toISOString()
        await db.setting.upsert({
          where: { key },
          update: { value, type, description, updatedAt: now },
          create: { key, value, type, description, createdAt: now, updatedAt: now },
        })
      }

      // Start job runtime with recovery
      await desktopServices.jobRuntime.resumePending()
      desktopServices.jobRuntime.start()

      // Pause/resume job runtime on system suspend/resume
      powerMonitor.on('suspend', () => {
        services?.jobRuntime.pause()
      })
      powerMonitor.on('resume', () => {
        services?.jobRuntime.resume()
      })

      log.info(`[main] Registered IPC channels: ${dispatcher.getRegisteredChannels().join(', ')}`)
      await writeStartupDiagnosticsArtifact(desktopServices, dispatcher)

      ipcMain.handle('bitsentry:llm:getProviders', async () => {
        const primarySetting = await db.setting.findUnique({ where: { key: 'llm.provider' } })
        const primaryKey = getDesktopLocalPrimaryProviderKey(
          readSettingString(primarySetting),
        )

        const listReadyModels = async (
          provider: LocalAiProviderService,
          providerKey: LocalAiProviderKey,
          isReady: boolean,
        ): Promise<string[]> => {
          if (!isReady) return []
          if (providerKey === 'cursor') return getCatalogModelIds('cursor')
          return provider.listModels(providerKey)
        }

        return buildDesktopLocalProviderRecords({
          localAiProvider,
          primaryProviderKey: primaryKey,
          readModelSetting: async (providerKey) => {
            const setting = await db.setting.findUnique({
              where: { key: `llm.${providerKey}.model` },
            })
            return readSettingString(setting)
          },
          resolveAvailableModels: (providerKey, isReady, provider) =>
            listReadyModels(
              provider as LocalAiProviderService,
              providerKey,
              isReady,
            ),
        })
      })

      ipcMain.handle(
        'bitsentry:llm:saveProvider',
        async (
          _event,
          providerKey: string,
          config: { model?: string; availableModels?: string[]; isSelectable?: boolean; isPrimary?: boolean },
        ) => {
          if (!isDesktopLocalAiProviderKey(providerKey)) {
            throw new Error(`Unsupported provider key: ${providerKey}`)
          }
          await saveDesktopProviderSettings({
            providerKey,
            config,
            upsertSetting,
          })

          return { ok: true }
        },
      )

      ipcMain.handle('bitsentry:database:reset', async () => {
        await services?.jobRuntime.stop()
        await resetDatabase()
        services?.jobRuntime.start()
        return { ok: true }
      })

      await createWindow()
      if (desktopShell.mainWindow !== null) {
        createIPCHandler({
          router: createDesktopTrpcRouter(dispatcher),
          windows: [getBrowserWindow()].filter((window): window is BrowserWindow => window !== null),
        })
      }

      if (isSmokeTest && isRunbookSmokeScenario) {
        await waitForRendererReady()
        const runbookId = randomUUID()
        await dispatcher.dispatch('runbooks:create', {
          id: runbookId,
          title: 'Smoke: no-op local runbook',
          description: 'Packaged smoke fixture. Contains no executable actions.',
        })
        const started = await dispatcher.dispatch('runbooks:execute', { runbookId })
        if (
          started === null ||
          typeof started !== 'object' ||
          typeof (started as { executionId?: unknown }).executionId !== 'string'
        ) {
          throw new Error('Runbook smoke scenario did not return an execution id')
        }
        const executionId = (started as { executionId: string }).executionId
        const execution = await runbookExecutionService.waitForCompletion(executionId, {
          timeoutMs: 10_000,
        })
        if (execution?.status !== 'completed') {
          throw new Error(`Runbook smoke scenario did not complete: ${execution?.status ?? 'missing'}`)
        }
        log.warn(SMOKE_RUNBOOK_COMPLETE_MARKER)
        writeSmokeMarker(SMOKE_RUNBOOK_COMPLETE_MARKER)
        app.quit()
      }

      app.on('activate', () => {
        if (desktopShell.mainWindow === null) void createWindow()
      })
    } catch (error) {
      closeSplashWindow()
      log.error('[main] Startup failed:', error)
      dialog.showErrorBox(
        `${APP_NAME} failed to start`,
        `${formatStartupError(error)}\n\nSee the log file at:\n${path.join(
          app.getPath('logs'),
          'main.log',
        )}`,
      )
      app.quit()
    }
  })
  .catch((error: unknown) => {
    closeSplashWindow()
    log.error('[main] Fatal bootstrap error:', error)
    app.quit()
  })
