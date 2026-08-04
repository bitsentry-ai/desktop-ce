import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  type DesktopTelemetrySettingsDb,
} from './desktop-telemetry-consent'

const PRODUCT_NAME = 'bitsentry-desktop'
const PRIVACY_SENSITIVE_INTEGRATIONS = new Set([
  'ContextLines',
  'LocalVariables',
  'LocalVariablesAsync',
  'Screenshots',
])

type DesktopSentryLevel = 'info' | 'warning' | 'error'

export interface DesktopSentryEvent {
  exception?: {
    values?: Array<{
      value?: string
    }>
  }
  extra?: Record<string, unknown>
}

export interface DesktopSentryBreadcrumb {
  category?: string
  data?: Record<string, unknown>
  level?: DesktopSentryLevel
  message?: string
}

export interface DesktopSentryIntegration {
  name: string
}

export interface DesktopSentryPort {
  IPCMode: {
    Classic: unknown
  }
  init(options: {
    dsn: string
    release: string
    environment: string
    ipcMode: unknown
    attachScreenshot: boolean
    includeLocalVariables: boolean
    enableRendererProfiling: boolean
    sendDefaultPii: boolean
    beforeSend(event: DesktopSentryEvent): DesktopSentryEvent | null
    beforeBreadcrumb(
      breadcrumb: DesktopSentryBreadcrumb,
    ): DesktopSentryBreadcrumb | null
    tracesSampleRate: number
    profilesSampleRate: number
    integrations(
      defaults: DesktopSentryIntegration[],
    ): DesktopSentryIntegration[]
  }): void
  setTag(key: string, value: string): void
  setContext(key: string, context: Record<string, unknown>): void
  close(timeout: number): Promise<unknown>
  captureException(
    error: unknown,
    options?: { extra: Record<string, unknown> },
  ): void
  captureMessage(message: string, level?: DesktopSentryLevel): void
  addBreadcrumb(breadcrumb: DesktopSentryBreadcrumb): void
  startInactiveSpan(options: { name: string; op: string }): unknown
}

export interface DesktopSentryRuntime {
  getRuntimeAppVersion(): string
}

export interface DesktopSentryLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

export interface CreateDesktopSentryOptions {
  dsn: string
  releaseChannel: string
  runtime: DesktopSentryRuntime
  logger: DesktopSentryLogger
  loadSentryMain(): Promise<DesktopSentryPort>
}

export interface DesktopSentryApi {
  hasSentryDsn(): boolean
  isSentryEnabled(db: DesktopTelemetrySettingsDb): Promise<boolean>
  setSentryEnabled(
    db: DesktopTelemetrySettingsDb,
    enabled: boolean,
  ): Promise<void>
  initSentryMain(): Promise<void>
  initSentryIfEnabled(db: DesktopTelemetrySettingsDb): Promise<void>
  closeSentry(): Promise<void>
  captureException(error: unknown, context?: Record<string, unknown>): void
  captureMessage(message: string, level?: DesktopSentryLevel): void
  addBreadcrumb(
    category: string,
    message: string,
    data?: Record<string, unknown>,
  ): void
  startTransaction(name: string, op: string): unknown
}

export function createDesktopSentry(
  options: CreateDesktopSentryOptions,
): DesktopSentryApi {
  let initialized = false
  let sentryModule: DesktopSentryPort | null = null
  let sentryLoadPromise: Promise<DesktopSentryPort> | null = null

  async function loadSentryMain(): Promise<DesktopSentryPort> {
    if (sentryModule !== null) {
      return sentryModule
    }

    sentryLoadPromise ??= options.loadSentryMain()
      .then((module) => {
        sentryModule = module
        return module
      })
      .catch((error: unknown) => {
        sentryLoadPromise = null
        throw error
      })

    return sentryLoadPromise
  }

  async function initSentryMain(): Promise<void> {
    if (initialized || options.dsn.length === 0) {
      if (options.dsn.length === 0) {
        options.logger.info('[sentry] No DSN configured, skipping initialization')
      }
      return
    }

    const SentryMain = await loadSentryMain()
    let environment = 'desktop-production'
    if (process.env.NODE_ENV === 'development') {
      environment = 'desktop-development'
    }
    const appVersion = options.runtime.getRuntimeAppVersion()
    const release = `${PRODUCT_NAME}@${appVersion}`

    SentryMain.init({
      dsn: options.dsn,
      release,
      environment,
      ipcMode: SentryMain.IPCMode.Classic,
      attachScreenshot: false,
      includeLocalVariables: false,
      enableRendererProfiling: true,
      sendDefaultPii: false,
      beforeSend(event) {
        return scrubSensitiveData(event)
      },
      beforeBreadcrumb(breadcrumb) {
        return scrubBreadcrumb(breadcrumb)
      },
      tracesSampleRate: 0.2,
      profilesSampleRate: 0.1,
      integrations(defaults) {
        return defaults.filter((integration) => !PRIVACY_SENSITIVE_INTEGRATIONS.has(integration.name))
      },
    })

    SentryMain.setTag('product', PRODUCT_NAME)
    SentryMain.setTag('runtime', 'main')
    SentryMain.setTag('release_channel', options.releaseChannel)
    SentryMain.setContext('desktop_app', {
      appVersion,
      releaseChannel: options.releaseChannel,
      platform: process.platform,
    })

    initialized = true
    options.logger.info(
      '[sentry] Initialized for main process',
      JSON.stringify({
        environment,
        release,
        releaseChannel: options.releaseChannel,
        tracesSampleRate: 0.2,
        profilesSampleRate: 0.1,
      }),
    )
  }

  return {
    hasSentryDsn(): boolean {
      return options.dsn.length > 0
    },

    async isSentryEnabled(db: DesktopTelemetrySettingsDb): Promise<boolean> {
      return isTelemetryEnabled(db)
    },

    async setSentryEnabled(
      db: DesktopTelemetrySettingsDb,
      enabled: boolean,
    ): Promise<void> {
      await setTelemetryEnabled(db, enabled)
    },

    initSentryMain,

    async initSentryIfEnabled(db: DesktopTelemetrySettingsDb): Promise<void> {
      try {
        const enabled = await isTelemetryEnabled(db)
        if (enabled) {
          await initSentryMain()
        }
      } catch (error: unknown) {
        options.logger.warn(
          '[sentry] Failed to initialize Sentry, continuing without telemetry',
          error,
        )
      }
    },

    async closeSentry(): Promise<void> {
      if (!initialized || sentryModule === null) return
      await sentryModule.close(2000)
      initialized = false
      options.logger.info('[sentry] Closed')
    },

    captureException(error: unknown, context?: Record<string, unknown>): void {
      if (!initialized || sentryModule === null) return
      if (context !== undefined) {
        sentryModule.captureException(error, { extra: context })
        return
      }

      sentryModule.captureException(error)
    },

    captureMessage(
      message: string,
      level: DesktopSentryLevel = 'info',
    ): void {
      if (!initialized || sentryModule === null) return
      sentryModule.captureMessage(message, level)
    },

    addBreadcrumb(
      category: string,
      message: string,
      data?: Record<string, unknown>,
    ): void {
      if (!initialized || sentryModule === null) return
      sentryModule.addBreadcrumb({ category, message, data, level: 'info' })
    },

    startTransaction(name: string, op: string): unknown {
      if (!initialized || sentryModule === null) return undefined
      return sentryModule.startInactiveSpan({ name, op })
    },
  }
}

function scrubExceptions(event: DesktopSentryEvent): void {
  const exceptions = event.exception?.values
  if (exceptions === undefined) {
    return
  }

  for (const exception of exceptions) {
    if (exception.value !== undefined) {
      exception.value = redactPatterns(exception.value)
    }
  }
}

function scrubRecord(data: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = { ...data }
  for (const key of Object.keys(scrubbed)) {
    const value = scrubbed[key]
    if (isSensitiveKey(key)) {
      scrubbed[key] = '[Redacted]'
      continue
    }

    if (typeof value === 'string') {
      scrubbed[key] = redactPatterns(value)
    }
  }

  return scrubbed
}

function scrubSensitiveData(
  event: DesktopSentryEvent,
): DesktopSentryEvent | null {
  scrubExceptions(event)

  if (event.extra !== undefined) {
    event.extra = scrubRecord(event.extra)
  }

  return event
}

function scrubBreadcrumb(
  breadcrumb: DesktopSentryBreadcrumb,
): DesktopSentryBreadcrumb | null {
  if (breadcrumb.data !== undefined) {
    breadcrumb.data = scrubRecord(breadcrumb.data)
  }

  if (breadcrumb.message !== undefined && breadcrumb.message.length > 0) {
    breadcrumb.message = redactPatterns(breadcrumb.message)
  }

  return breadcrumb
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower.includes('password') ||
    lower.includes('secret') ||
    lower.includes('token') ||
    lower.includes('apikey') ||
    lower.includes('api_key') ||
    lower.includes('authorization') ||
    lower.includes('credential') ||
    lower.includes('private_key')
  )
}

function redactPatterns(value: string): string {
  return value
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
    .replace(/ssh:\/\/[^\s]+/gi, 'ssh://[Redacted]')
    .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi, '$1=[Redacted]')
}
