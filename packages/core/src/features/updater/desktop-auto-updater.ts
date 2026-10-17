import {
  getUpdateDownloadPolicy,
  type AutoUpdaterDisabledReasonCode,
} from './desktop-updater-policy'

export const UPDATER_STATE_CHANNEL = 'bitsentry:updater:state'

export type UpdaterStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdaterState {
  status: UpdaterStatus
  appVersion: string
  availableVersion: string | null
  downloadedVersion: string | null
  downloadPercent: number | null
  checkedAt: string | null
  message: string | null
  disabledReasonCode: AutoUpdaterDisabledReasonCode | null
}

export type DesktopUpdaterWindow = {
  isDestroyed(): boolean
  webContents: {
    send(channel: string, payload: UpdaterState): void
  }
}

export type DesktopUpdaterIpcMain = {
  handle(
    channel: string,
    listener: (_event: unknown, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

export type DesktopUpdaterLogger = {
  info(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export type DesktopUpdaterUpdateInfo = {
  version: string
}

export type DesktopUpdaterProgressInfo = {
  percent: number
}

export type DesktopAutoUpdaterPort = {
  logger?: unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  setFeedURL(url: string): void
  on(
    event: 'checking-for-update' | 'update-not-available',
    listener: () => void,
  ): void
  on(
    event: 'download-progress',
    listener: (progress: DesktopUpdaterProgressInfo) => void,
  ): void
  on(
    event: 'update-available' | 'update-downloaded',
    listener: (info: DesktopUpdaterUpdateInfo) => void,
  ): void
  on(event: 'error', listener: (error: unknown) => void): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  removeAllListeners(): void
}

export interface StartDesktopAutoUpdaterOptions {
  ipcMain: DesktopUpdaterIpcMain
  autoUpdater: DesktopAutoUpdaterPort
  logger: DesktopUpdaterLogger
  currentVersion: string
  getWindow: () => DesktopUpdaterWindow | null
  shouldEnable: boolean
  disabledReasonCode: AutoUpdaterDisabledReasonCode | null
  feedUrl: string | null
  beforeInstall: () => Promise<void> | void
}

const STARTUP_DELAY_MS = 15_000
const POLL_INTERVAL_MS = 4 * 60_000

function createInitialState(options: {
  currentVersion: string
  disabledReasonCode: AutoUpdaterDisabledReasonCode | null
}): UpdaterState {
  let status: UpdaterStatus = 'idle'
  if (options.disabledReasonCode !== null) {
    status = 'disabled'
  }

  return {
    status,
    appVersion: options.currentVersion,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    disabledReasonCode: options.disabledReasonCode,
  }
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error === null || error === undefined) return 'Unknown error'
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)
  return JSON.stringify(error)
}

export function startDesktopAutoUpdater(
  options: StartDesktopAutoUpdaterOptions,
): {
  stop: () => void
  getState: () => UpdaterState
} {
  let state = createInitialState({
    currentVersion: options.currentVersion,
    disabledReasonCode: options.disabledReasonCode,
  })
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let checkInFlight = false
  let downloadInFlight = false
  let installInFlight = false
  let stopped = false

  const broadcast = (): void => {
    const window = options.getWindow()
    if (window === null || window.isDestroyed()) return
    window.webContents.send(UPDATER_STATE_CHANNEL, state)
  }

  const setState = (patch: Partial<UpdaterState>): void => {
    state = { ...state, ...patch }
    broadcast()
  }

  const isoNow = (): string => new Date().toISOString()

  if (!options.shouldEnable) {
    options.logger.info(
      `[updater] disabled: ${options.disabledReasonCode ?? 'unknown reason'}`,
    )
  } else {
    options.autoUpdater.logger = options.logger
    options.autoUpdater.autoDownload = false
    options.autoUpdater.autoInstallOnAppQuit = true
    if (options.feedUrl !== null) {
      options.autoUpdater.setFeedURL(options.feedUrl)
      options.logger.info(`[updater] using feed URL: ${options.feedUrl}`)
    }

    options.autoUpdater.on('checking-for-update', () => {
      if (stopped) return
      setState({ status: 'checking', message: null })
    })

    options.autoUpdater.on('update-available', (info) => {
      if (stopped) return
      const downloadPolicy = getUpdateDownloadPolicy({
        currentVersion: state.appVersion,
        availableVersion: info.version,
      })
      setState({
        status: 'available',
        availableVersion: info.version,
        message: null,
        checkedAt: isoNow(),
      })
      options.logger.info(
        `[updater] update available: ${info.version} (policy=${downloadPolicy})`,
      )
      if (downloadPolicy === 'auto') {
        void triggerDownload('auto')
      }
    })

    options.autoUpdater.on('update-not-available', () => {
      if (stopped) return
      let status: UpdaterStatus = 'idle'
      if (state.downloadedVersion !== null) {
        status = 'downloaded'
      }

      setState({
        status,
        availableVersion: null,
        checkedAt: isoNow(),
      })
    })

    options.autoUpdater.on('download-progress', (progress) => {
      if (stopped) return
      const percent = Math.floor(progress.percent)
      const previous = state.downloadPercent ?? -1
      if (percent === 100 || Math.floor(percent / 5) !== Math.floor(previous / 5)) {
        setState({ status: 'downloading', downloadPercent: percent })
      }
    })

    options.autoUpdater.on('update-downloaded', (info) => {
      if (stopped) return
      setState({
        status: 'downloaded',
        downloadedVersion: info.version,
        downloadPercent: 100,
        message: null,
      })
      options.logger.info(`[updater] update downloaded: ${info.version}`)
    })

    options.autoUpdater.on('error', (error) => {
      if (stopped) return
      const message = toMessage(error)
      options.logger.error(`[updater] error: ${message}`)
      checkInFlight = false
      downloadInFlight = false
      installInFlight = false
      setState({ status: 'error', message })
    })
  }

  const triggerCheck = async (reason: string): Promise<void> => {
    if (stopped || !options.shouldEnable) return
    if (checkInFlight) return
    if (state.status === 'downloading' || state.status === 'downloaded' || state.status === 'installing') {
      return
    }
    checkInFlight = true
    try {
      options.logger.info(`[updater] checking for updates (${reason})`)
      await options.autoUpdater.checkForUpdates()
    } catch (error) {
      options.logger.error(`[updater] check failed: ${toMessage(error)}`)
      setState({ status: 'error', message: toMessage(error), checkedAt: isoNow() })
    } finally {
      checkInFlight = false
    }
  }

  const triggerDownload = async (reason = 'manual'): Promise<{ accepted: boolean }> => {
    if (stopped || !options.shouldEnable) return { accepted: false }
    if (downloadInFlight) return { accepted: false }
    if (state.status !== 'available' && state.status !== 'error') {
      return { accepted: false }
    }
    downloadInFlight = true
    try {
      options.logger.info(`[updater] downloading update (${reason})`)
      setState({ status: 'downloading', downloadPercent: 0, message: null })
      await options.autoUpdater.downloadUpdate()
      return { accepted: true }
    } catch (error) {
      options.logger.error(`[updater] download failed: ${toMessage(error)}`)
      setState({ status: 'error', message: toMessage(error) })
      return { accepted: false }
    } finally {
      downloadInFlight = false
    }
  }

  const triggerInstall = async (): Promise<{ accepted: boolean }> => {
    if (stopped || !options.shouldEnable) return { accepted: false }
    if (installInFlight) return { accepted: false }
    if (state.status !== 'downloaded') return { accepted: false }
    installInFlight = true
    setState({ status: 'installing' })
    try {
      await options.beforeInstall()
      options.autoUpdater.quitAndInstall(true, true)
      return { accepted: true }
    } catch (error) {
      options.logger.error(`[updater] install failed: ${toMessage(error)}`)
      installInFlight = false
      setState({ status: 'error', message: toMessage(error) })
      return { accepted: false }
    }
  }

  options.ipcMain.handle('bitsentry:updater:getState', () => state)
  options.ipcMain.handle('bitsentry:updater:check', async () => {
    await triggerCheck('manual')
    return state
  })
  options.ipcMain.handle('bitsentry:updater:download', async () => {
    return triggerDownload()
  })
  options.ipcMain.handle('bitsentry:updater:install', async () => {
    return triggerInstall()
  })

  if (options.shouldEnable) {
    startupTimer = setTimeout(() => {
      startupTimer = null
      void triggerCheck('startup')
    }, STARTUP_DELAY_MS)
    pollTimer = setInterval(() => {
      void triggerCheck('poll')
    }, POLL_INTERVAL_MS)
  }

  let pushAttempts = 0
  const initialPush = setInterval(() => {
    pushAttempts += 1
    const window = options.getWindow()
    if (window !== null && !window.isDestroyed()) {
      broadcast()
      clearInterval(initialPush)
      return
    }
    if (pushAttempts > 20) clearInterval(initialPush)
  }, 500)

  return {
    stop: () => {
      stopped = true
      if (startupTimer !== null) clearTimeout(startupTimer)
      if (pollTimer !== null) clearInterval(pollTimer)
      clearInterval(initialPush)
      options.ipcMain.removeHandler('bitsentry:updater:getState')
      options.ipcMain.removeHandler('bitsentry:updater:check')
      options.ipcMain.removeHandler('bitsentry:updater:download')
      options.ipcMain.removeHandler('bitsentry:updater:install')
      options.autoUpdater.removeAllListeners()
    },
    getState: () => state,
  }
}
