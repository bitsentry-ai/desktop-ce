import path from 'path'
import { mkdir, writeFile } from 'fs/promises'

export interface DesktopShellWindowPort {
  webContents: {
    send: (...args: unknown[]) => unknown
    on: (...args: unknown[]) => unknown
    loadFile: (...args: unknown[]) => unknown
    loadURL: (...args: unknown[]) => unknown
    setWindowOpenHandler: (...args: unknown[]) => unknown
  }
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  focus: () => void
  close: () => void
  show: () => void
  minimize: () => void
  removeMenu: () => void
  on: (...args: unknown[]) => unknown
  once: (...args: unknown[]) => unknown
  loadURL: (...args: unknown[]) => unknown
}

export interface DesktopShellBrowserWindowFactory {
  new (options?: unknown): unknown
}

export interface DesktopShellAppPort {
  isPackaged: boolean
  getName: () => string
  getVersion: () => string
  getPath: (name: 'userData' | 'logs') => string
}

export interface CreateDesktopElectronShellOptions {
  app: DesktopShellAppPort
  appName: string
  splashTitle: string
  browserWindow: DesktopShellBrowserWindowFactory
  readTextFile: (filePath: string) => string
  resolveResourcesPath: () => string
}

export interface DesktopElectronShell {
  mainWindow: DesktopShellWindowPort | null
  splashWindow: DesktopShellWindowPort | null
  getAssetPath: (...paths: string[]) => string
  focusOpenWindow: () => void
  createSplashWindow: () => void
  closeSplashWindow: () => void
}

export interface DesktopStartupDiagnosticsServices {
  jobRuntime: {
    listSchedules: () => Promise<unknown>
    list: (filter: { status: 'queued' }) => Promise<unknown[]>
  }
}

export interface DesktopStartupDiagnosticsDispatcher {
  getRegisteredChannels: () => string[]
}

export interface DesktopShellLoggerPort {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export interface CreateDesktopMainWindowOptions {
  browserWindow: DesktopShellBrowserWindowFactory
  desktopShell: DesktopElectronShell
  isDebug: boolean
  isSmokeTest: boolean
  autoQuitSmokeTest?: boolean
  smokeTestReadyMarker: string
  onSmokeTestReady?: () => void
  preloadPath: string
  localRendererPath: string
  installReactDevTools: () => Promise<void>
  setPermissionRequestHandler: (handler: (...args: unknown[]) => void) => void
  logger: DesktopShellLoggerPort
  openExternal: (url: string) => void
  onRendererReady: () => void
  onWindowClosed: () => void
  createMenu: (window: DesktopShellWindowPort) => void
  quitApp: () => void
}

export function formatDesktopStartupError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

export async function writeDesktopStartupDiagnosticsArtifact(
  app: DesktopShellAppPort,
  services: DesktopStartupDiagnosticsServices,
  dispatcher: DesktopStartupDiagnosticsDispatcher,
): Promise<void> {
  const diagnosticsDir = path.join(app.getPath('userData'), 'diagnostics')
  try {
    await mkdir(diagnosticsDir, { recursive: true })

    const [schedules, queuedJobs] = await Promise.all([
      services.jobRuntime.listSchedules(),
      services.jobRuntime.list({ status: 'queued' }),
    ])

    const artifact = {
      generatedAt: new Date().toISOString(),
      app: {
        name: app.getName(),
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      paths: {
        userData: app.getPath('userData'),
        logs: app.getPath('logs'),
      },
      runtime: {
        queuedJobs: queuedJobs.length,
        schedules,
        registeredChannels: dispatcher.getRegisteredChannels().sort(),
      },
    }

    await writeFile(
      path.join(diagnosticsDir, 'startup-diagnostics.json'),
      JSON.stringify(artifact, null, 2),
      'utf-8',
    )
  } catch (error) {
    throw new Error(
      `[main] Failed to write startup diagnostics artifact: ${formatDesktopStartupError(error)}`,
    )
  }
}

export async function createDesktopMainWindow(
  options: CreateDesktopMainWindowOptions,
): Promise<void> {
  if (options.isDebug) {
    try {
      await options.installReactDevTools()
    } catch (error) {
      options.logger.error(
        `Failed to install React DevTools: ${formatDesktopStartupError(error)}`,
      )
    }
  }

  const mainWindowOptions: Record<string, unknown> = {
    show: false,
    width: 1180,
    height: 800,
    minWidth: 1180,
    minHeight: 800,
    icon: options.desktopShell.getAssetPath('icon.png'),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  }
  if (process.platform === 'darwin') {
    mainWindowOptions.titleBarStyle = 'hiddenInset'
    mainWindowOptions.trafficLightPosition = { x: 14, y: 17 }
  } else {
    mainWindowOptions.titleBarStyle = 'hidden'
    mainWindowOptions.titleBarOverlay = {
      color: '#00000000',
      symbolColor: '#737373',
      height: 48,
    }
  }

  options.desktopShell.mainWindow = new options.browserWindow(
    mainWindowOptions,
  ) as DesktopShellWindowPort

  options.setPermissionRequestHandler((...args: unknown[]) => {
    const callback = args[2]
    if (typeof callback === 'function') {
      ;(callback as (allowed: boolean) => void)(false)
    }
  })

  let attemptedRendererFileFallback = false
  const fallbackRendererToLocalBuild = () => {
    if (
      options.desktopShell.mainWindow === null ||
      options.desktopShell.mainWindow.isDestroyed() ||
      attemptedRendererFileFallback
    ) {
      return
    }
    attemptedRendererFileFallback = true
    options.logger.warn(
      `[renderer] Falling back to local renderer build at ${options.localRendererPath}`,
    )
    void options.desktopShell.mainWindow.webContents.loadFile(options.localRendererPath)
  }

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl !== undefined && rendererUrl.length > 0) {
    void options.desktopShell.mainWindow.webContents.loadURL(rendererUrl)
  } else {
    void options.desktopShell.mainWindow.webContents.loadFile(options.localRendererPath)
  }

  options.desktopShell.mainWindow.webContents.on('console-message', (...args: unknown[]) => {
    const details = args[0] as {
      level?: string
      message?: string
      lineNumber?: number
      sourceId?: string
    }
    const level = details.level ?? ''
    const message = details.message ?? ''
    const lineNumber = details.lineNumber ?? 0
    const sourceId = details.sourceId ?? ''
    let lineInfo = `line:${String(lineNumber)}`
    if (sourceId.length > 0) {
      lineInfo = `${sourceId}:${String(lineNumber)}`
    }
    const rendererMessage = `[renderer:console] ${lineInfo} ${message}`

    if (level === 'error') {
      options.logger.error(rendererMessage)
    } else if (level === 'warning') {
      options.logger.warn(rendererMessage)
    } else {
      options.logger.info(rendererMessage)
    }
  })

  options.desktopShell.mainWindow.webContents.on('did-fail-load', (...args: unknown[]) => {
    const errorCode = args[1]
    const errorDescription = args[2]
    let validatedURL = ''
    if (typeof args[3] === 'string') {
      validatedURL = args[3]
    }
    const isMainFrame = args[4] === true
    options.logger.error(
      `[renderer] did-fail-load code=${String(errorCode)} mainFrame=${String(isMainFrame)} url=${validatedURL} error=${String(errorDescription)}`,
    )
    const normalizedRendererUrl = (process.env.ELECTRON_RENDERER_URL ?? '').replace(/\/+$/, '')
    const normalizedValidatedUrl = validatedURL.replace(/\/+$/, '')
    if (
      isMainFrame &&
      errorCode === -102 &&
      normalizedRendererUrl.length > 0 &&
      normalizedValidatedUrl === normalizedRendererUrl
    ) {
      fallbackRendererToLocalBuild()
    }
  })

  options.desktopShell.mainWindow.webContents.on('did-finish-load', () => {
    options.onRendererReady()
    if (options.isSmokeTest) {
      options.logger.warn(options.smokeTestReadyMarker)
      options.onSmokeTestReady?.()
      if (options.autoQuitSmokeTest !== false) {
        setTimeout(() => {
          options.quitApp()
        }, 500)
      }
    }
  })

  options.desktopShell.mainWindow.webContents.on('preload-error', (...args: unknown[]) => {
    let preloadPath = ''
    if (typeof args[1] === 'string') {
      preloadPath = args[1]
    }
    const error = formatDesktopStartupError(args[2])
    options.logger.error(`[renderer] preload-error at ${preloadPath}: ${error}`)
  })

  options.desktopShell.mainWindow.webContents.on('render-process-gone', (...args: unknown[]) => {
    const details = (args[1] ?? {}) as { reason?: string; exitCode?: number }
    options.logger.error(
      `[renderer] render-process-gone reason=${details.reason ?? ''} exitCode=${String(details.exitCode ?? '')}`,
    )
  })

  options.desktopShell.mainWindow.on('ready-to-show', () => {
    options.desktopShell.closeSplashWindow()

    if (options.desktopShell.mainWindow === null) {
      throw new Error('"mainWindow" is not defined')
    }
    if (process.env.START_MINIMIZED !== undefined && process.env.START_MINIMIZED.length > 0) {
      options.desktopShell.mainWindow.minimize()
    } else {
      options.desktopShell.mainWindow.show()
    }
  })

  options.desktopShell.mainWindow.on('closed', () => {
    options.onWindowClosed()
    options.desktopShell.mainWindow = null
  })

  options.createMenu(options.desktopShell.mainWindow)

  options.desktopShell.mainWindow.webContents.setWindowOpenHandler((event: { url: string }) => {
    const allowed = /^https?:\/\//i.test(event.url)
    if (allowed) {
      options.openExternal(event.url)
    }
    return { action: 'deny' }
  })

  options.desktopShell.mainWindow.webContents.on('will-navigate', (...args: unknown[]) => {
    const event = args[0] as { preventDefault: () => void }
    let url = ''
    if (typeof args[1] === 'string') {
      url = args[1]
    }
    let allowedDev = false
    if (rendererUrl !== undefined && rendererUrl.length > 0) {
      allowedDev = url.startsWith(rendererUrl)
    }
    const allowedFile = url.startsWith('file://')
    if (!allowedDev && !allowedFile) {
      event.preventDefault()
      options.openExternal(url)
    }
  })
}

export function createDesktopElectronShell(
  options: CreateDesktopElectronShellOptions,
): DesktopElectronShell {
  const desktopShell: DesktopElectronShell = {
    mainWindow: null,
    splashWindow: null,
    getAssetPath: (...paths: string[]): string => {
      let resourcesPath = path.join(__dirname, '../../assets')
      if (options.app.isPackaged) {
        resourcesPath = path.join(options.resolveResourcesPath(), 'assets')
      }
      return path.join(resourcesPath, ...paths)
    },
    focusOpenWindow: (): void => {
      if (desktopShell.mainWindow !== null) {
        if (desktopShell.mainWindow.isMinimized()) desktopShell.mainWindow.restore()
        desktopShell.mainWindow.focus()
      } else if (desktopShell.splashWindow !== null) {
        desktopShell.splashWindow.focus()
      }
    },
    createSplashWindow: (): void => {
      if (desktopShell.splashWindow !== null && !desktopShell.splashWindow.isDestroyed()) return

      desktopShell.splashWindow = new options.browserWindow({
        width: 460,
        height: 300,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        alwaysOnTop: true,
        center: true,
        backgroundColor: '#000000',
        icon: desktopShell.getAssetPath('icon.png'),
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      }) as DesktopShellWindowPort

      desktopShell.splashWindow.removeMenu()
      desktopShell.splashWindow.on('closed', () => {
        desktopShell.splashWindow = null
      })

      desktopShell.splashWindow.once('ready-to-show', () => {
        const window = desktopShell.splashWindow
        if (window === null) return
        window.show()
      })

      const splashLogoUrl = `data:image/png;base64,${options.readTextFile(
        desktopShell.getAssetPath('icon.png'),
      )}`

      const splashHtml = `<!doctype html>
  <html>
  <head>
    <meta charset="UTF-8" />
    <title>${options.appName}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        height: 100vh;
        display: grid;
        place-items: center;
        background: #000000;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f5f5f5;
      }
      .panel {
        width: 320px;
        text-align: center;
      }
      .logo {
        width: 56px;
        height: 56px;
        margin: 0 auto 18px;
        display: block;
        border-radius: 14px;
      }
      .title {
        font-size: 28px;
        font-weight: 650;
        letter-spacing: 0.4px;
      }
      .subtitle {
        margin-top: 12px;
        font-size: 13px;
        color: #9ca3af;
      }
      .spinner {
        width: 34px;
        height: 34px;
        margin: 22px auto 0;
        border-radius: 999px;
        border: 3px solid rgba(255, 255, 255, 0.18);
        border-top-color: #f5f5f5;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <div class="panel">
      <img class="logo" src="${splashLogoUrl}" alt="BitSentry logo" />
      <div class="title">${options.splashTitle}</div>
      <div class="subtitle">Initializing ${options.appName}...</div>
      <div class="spinner"></div>
    </div>
  </body>
  </html>`

      void desktopShell.splashWindow.loadURL(
        `data:text/html;charset=UTF-8,${encodeURIComponent(splashHtml)}`,
      )
    },
    closeSplashWindow: (): void => {
      if (desktopShell.splashWindow !== null && !desktopShell.splashWindow.isDestroyed()) {
        desktopShell.splashWindow.close()
      }
      desktopShell.splashWindow = null
    },
  }

  return desktopShell
}
