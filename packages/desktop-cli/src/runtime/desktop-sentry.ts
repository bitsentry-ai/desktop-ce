import log from 'electron-log'
import {
  createDesktopSentryBindings,
  type DesktopSentryPort,
} from '@bitsentry-ce/core/features/analytics'
import { getRuntimeAppVersion } from './electron-app.js'

declare global {
  var __BITSENTRY_TEST_LOAD_SENTRY_MAIN__: (() => Promise<DesktopSentryPort>) | undefined
}

function loadSentryMainRuntime(): Promise<DesktopSentryPort> {
  if (typeof globalThis.__BITSENTRY_TEST_LOAD_SENTRY_MAIN__ === 'function') {
    return globalThis.__BITSENTRY_TEST_LOAD_SENTRY_MAIN__()
  }

  const sentryMainModule = '@sentry/electron/main'
  return import(sentryMainModule).then((module) => module as unknown as DesktopSentryPort)
}

const desktopSentry = createDesktopSentryBindings({
  runtime: { getRuntimeAppVersion },
  logger: log,
  loadSentryMain: () => loadSentryMainRuntime(),
})

export const hasSentryDsn = () => desktopSentry.hasSentryDsn()
export const isSentryEnabled = (...args: Parameters<typeof desktopSentry.isSentryEnabled>) =>
  desktopSentry.isSentryEnabled(...args)
export const setSentryEnabled = (...args: Parameters<typeof desktopSentry.setSentryEnabled>) =>
  desktopSentry.setSentryEnabled(...args)
export const initSentryMain = () => desktopSentry.initSentryMain()
export const initSentryIfEnabled = (
  ...args: Parameters<typeof desktopSentry.initSentryIfEnabled>
) => desktopSentry.initSentryIfEnabled(...args)
export const closeSentry = () => desktopSentry.closeSentry()
export const captureException = (...args: Parameters<typeof desktopSentry.captureException>) => {
  desktopSentry.captureException(...args)
}
export const captureMessage = (...args: Parameters<typeof desktopSentry.captureMessage>) => {
  desktopSentry.captureMessage(...args)
}
export const addBreadcrumb = (...args: Parameters<typeof desktopSentry.addBreadcrumb>) => {
  desktopSentry.addBreadcrumb(...args)
}

export function startTransaction(name: string, op: string): unknown {
  return desktopSentry.startTransaction(name, op)
}
