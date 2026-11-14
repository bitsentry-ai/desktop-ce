import * as Sentry from '@sentry/electron/renderer'
import { init as reactInit } from '@sentry/react'
import type { DesktopSentryRuntimeModule } from './DesktopSentry'

const desktopSentryRendererRuntime: DesktopSentryRuntimeModule = {
  sentryRuntime: {
    init(options, originalInit) {
      Sentry.init(
        options as Parameters<typeof Sentry.init>[0],
        originalInit,
      )
    },
    browserTracingIntegration: Sentry.browserTracingIntegration,
    browserProfilingIntegration: Sentry.browserProfilingIntegration,
    setTag: Sentry.setTag,
    setContext: Sentry.setContext,
    setUser: Sentry.setUser,
    captureException: Sentry.captureException,
    captureMessage: Sentry.captureMessage,
    getClient: Sentry.getClient,
    startBrowserTracingNavigationSpan(client, span, context) {
      Sentry.startBrowserTracingNavigationSpan(
        client as Parameters<typeof Sentry.startBrowserTracingNavigationSpan>[0],
        span,
        context,
      )
    },
  },
  reactInit(options) {
    reactInit(options as Parameters<typeof reactInit>[0])
  },
}

export default desktopSentryRendererRuntime
