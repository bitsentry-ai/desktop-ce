import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { captureDesktopAnalyticsException } from './DesktopPosthogRenderer'

let initialized = false
const TRACES_SAMPLE_RATE = 0.2
const PROFILE_SESSION_SAMPLE_RATE = 0.1
let PRODUCT_NAME = 'superterminal'

type DesktopSentryRuntime = {
  init: (
    options: {
      integrations: unknown[]
      tracesSampleRate: number
      profileSessionSampleRate: number
    },
    reactInit: DesktopReactInit,
  ) => void
  browserTracingIntegration: () => unknown
  browserProfilingIntegration: () => unknown
  setTag: (key: string, value: string) => void
  setContext: (name: string, context: Record<string, unknown>) => void
  setUser: (user: { id: string; email?: string } | null) => void
  captureException: (
    error: unknown,
    options?: { extra: Record<string, unknown> },
  ) => void
  captureMessage: (
    message: string,
    options: { level: 'info' | 'warning' | 'error'; extra?: Record<string, unknown> },
  ) => void
  getClient: () => unknown
  startBrowserTracingNavigationSpan: (
    client: unknown,
    span: { name: string; op: string },
    context: { url: string },
  ) => void
}

type DesktopReactInit = (options: unknown) => void

export type DesktopSentryApi = {
  initSentryRenderer: () => Promise<void>
  syncSentryUser: (user: { id: number; email: string | null } | null) => void
  captureRendererException: (
    error: unknown,
    context?: Record<string, unknown>,
  ) => void
  captureRendererMessage: (
    message: string,
    level?: 'info' | 'warning' | 'error',
    context?: Record<string, unknown>,
  ) => void
  DesktopRouteTracing: () => null
}

type ConfigureDesktopSentryRuntimeInput = {
  sentryRuntime: DesktopSentryRuntime
  reactInit: DesktopReactInit
  productName?: string
}

let configuredSentryRuntime: DesktopSentryRuntime | null = null
let configuredReactInit: DesktopReactInit | null = null

function getSentryRuntime(): DesktopSentryRuntime | null {
  return configuredSentryRuntime
}

export function configureDesktopSentryRuntime({
  sentryRuntime,
  reactInit,
  productName,
}: ConfigureDesktopSentryRuntimeInput): DesktopSentryApi {
  configuredSentryRuntime = sentryRuntime
  configuredReactInit = reactInit
  if (typeof productName === 'string' && productName.trim().length > 0) {
    PRODUCT_NAME = productName.trim()
  }

  return {
    initSentryRenderer,
    syncSentryUser,
    captureRendererException,
    captureRendererMessage,
    DesktopRouteTracing,
  }
}

type AnalyticsContext = {
  appVersion: string
  releaseChannel: string
  platform: string
}

type DesktopSentryBridge = {
  analytics: {
    getContext: () => Promise<{
      appVersion: string
      releaseChannel: string
      platform: string | number
    }>
  }
  sentry: {
    rendererShouldInit: () => Promise<boolean>
  }
}

function warnSentryFailure(action: string, error: unknown): void {
  console.warn(`[sentry] Failed to ${action}`, error)
}

function logSentry(message: string, details?: Record<string, unknown>): void {
  if (details !== undefined) {
    console.info('[sentry]', message, JSON.stringify(details))
    return
  }

  console.info('[sentry]', message)
}

function getDesktopSentryBridge(): DesktopSentryBridge {
  const bitsentry = (window as { bitsentry?: unknown }).bitsentry
  const bridge = bitsentry as DesktopSentryBridge | undefined
  if (
    bridge?.analytics === undefined ||
    bridge?.sentry === undefined ||
    typeof bridge.analytics.getContext !== 'function' ||
    typeof bridge.sentry.rendererShouldInit !== 'function'
  ) {
    throw new Error('Desktop Sentry bridge is unavailable')
  }

  return bridge
}

async function shouldInitializeRendererTelemetry(): Promise<boolean> {
  try {
    const shouldInit = await getDesktopSentryBridge().sentry.rendererShouldInit()
    if (!shouldInit) {
      logSentry(
        'Renderer telemetry skipped because consent is disabled or the main-process DSN is unavailable',
      )
    }

    return shouldInit
  } catch {
    // Preload not ready or IPC failed; skip initialization.
    logSentry('Renderer telemetry skipped because the preload bridge is not ready')
    return false
  }
}

async function loadAnalyticsContext(): Promise<AnalyticsContext | undefined> {
  try {
    const context = await getDesktopSentryBridge().analytics.getContext()
    return {
      appVersion: context.appVersion,
      releaseChannel: context.releaseChannel,
      platform: String(context.platform),
    }
  } catch (error: unknown) {
    warnSentryFailure('load renderer telemetry context', error)
    return undefined
  }
}

export async function initSentryRenderer(): Promise<void> {
  if (initialized) return

  const sentryRuntime = getSentryRuntime()
  if (sentryRuntime === null || configuredReactInit === null) {
    warnSentryFailure(
      'initialize renderer telemetry',
      new Error('Desktop Sentry runtime is unavailable'),
    )
    return
  }

  // Initialize only when BOTH the user has opted in AND the main process has
  // a DSN configured. Without a DSN the main client never inits, so any
  // renderer init below would spam IPC errors trying to reach a main-side
  // client that doesn't exist.
  const shouldInit = await shouldInitializeRendererTelemetry()
  if (!shouldInit) {
    return
  }

  const analyticsContext = await loadAnalyticsContext()

  // The renderer SDK forwards events through the main process Sentry client,
  // so no separate DSN is needed here.
  try {
    sentryRuntime.init(
      {
        integrations: [
          sentryRuntime.browserTracingIntegration(),
          sentryRuntime.browserProfilingIntegration(),
        ],
        tracesSampleRate: TRACES_SAMPLE_RATE,
        profileSessionSampleRate: PROFILE_SESSION_SAMPLE_RATE,
      },
      configuredReactInit,
    )

    sentryRuntime.setTag('product', PRODUCT_NAME)
    sentryRuntime.setTag('runtime', 'renderer')
    if (analyticsContext !== undefined) {
      sentryRuntime.setTag('release_channel', analyticsContext.releaseChannel)
      sentryRuntime.setTag('platform', analyticsContext.platform)
      sentryRuntime.setContext('desktop_app', {
        appVersion: analyticsContext.appVersion,
        releaseChannel: analyticsContext.releaseChannel,
        platform: analyticsContext.platform,
      })
    }

    initialized = true
    logSentry('Initialized renderer telemetry', {
      tracesSampleRate: TRACES_SAMPLE_RATE,
      profileSessionSampleRate: PROFILE_SESSION_SAMPLE_RATE,
      releaseChannel: analyticsContext?.releaseChannel,
      appVersion: analyticsContext?.appVersion,
      platform: analyticsContext?.platform,
    })
  } catch (error: unknown) {
    warnSentryFailure('initialize renderer telemetry', error)
  }
}

export function syncSentryUser(user: { id: number; email: string | null } | null): void {
  if (!initialized) {
    return
  }

  const sentryRuntime = getSentryRuntime()
  if (sentryRuntime === null) {
    return
  }

  try {
    if (user === null) {
      sentryRuntime.setUser(null)
      return
    }

    sentryRuntime.setUser({
      id: String(user.id),
      email: user.email ?? undefined,
    })
  } catch (error: unknown) {
    warnSentryFailure('sync user context', error)
  }
}

export function captureRendererException(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  try {
    captureDesktopAnalyticsException(error)
  } catch (captureError: unknown) {
    console.warn('[posthog] Failed to forward desktop exception', captureError)
  }

  if (!initialized) {
    return
  }

  const sentryRuntime = getSentryRuntime()
  if (sentryRuntime === null) {
    return
  }

  try {
    if (context === undefined) {
      sentryRuntime.captureException(error)
      return
    }

    sentryRuntime.captureException(error, { extra: context })
  } catch (captureError: unknown) {
    warnSentryFailure('capture renderer exception', captureError)
  }
}

export function captureRendererMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  context?: Record<string, unknown>,
): void {
  if (!initialized) {
    return
  }

  const sentryRuntime = getSentryRuntime()
  if (sentryRuntime === null) {
    return
  }

  try {
    sentryRuntime.captureMessage(message, {
      level,
      extra: context,
    })
  } catch (captureError: unknown) {
    warnSentryFailure('capture renderer message', captureError)
  }
}

export function DesktopRouteTracing(): null {
  const location = useLocation()
  const previousRouteRef = useRef<string | null>(null)

  useEffect(() => {
    if (!initialized) {
      return
    }

    const routeName = location.pathname
    if (previousRouteRef.current === null) {
      previousRouteRef.current = routeName
      return
    }

    if (previousRouteRef.current === routeName) {
      return
    }

    const sentryRuntime = getSentryRuntime()
    if (sentryRuntime === null) {
      return
    }

    const client = sentryRuntime.getClient()
    if (client !== undefined && typeof window !== 'undefined') {
      try {
        sentryRuntime.startBrowserTracingNavigationSpan(
          client,
          {
            name: routeName,
            op: 'navigation',
          },
          {
            url: window.location.origin + routeName,
          },
        )
      } catch (error: unknown) {
        warnSentryFailure('record route navigation span', error)
      }
    }

    previousRouteRef.current = routeName
  }, [location.pathname])

  return null
}
