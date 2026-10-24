import * as Sentry from '@sentry/electron/renderer'
import { init as reactInit } from '@sentry/react'
import { configureDesktopSentryRuntime } from './DesktopSentry'

type DesktopSentryRuntimeConfig = Parameters<
  typeof configureDesktopSentryRuntime
>[0]

const sentryRuntime = {
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
} satisfies DesktopSentryRuntimeConfig['sentryRuntime']

const sentryReactInit: DesktopSentryRuntimeConfig['reactInit'] = (options) => {
  reactInit(options as Parameters<typeof reactInit>[0])
}

export const {
  initSentryRenderer,
  captureRendererException,
  DesktopRouteTracing,
} = configureDesktopSentryRuntime({
  sentryRuntime,
  reactInit: sentryReactInit,
})
