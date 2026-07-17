import {
  createDesktopSentry,
  type DesktopSentryApi,
  type DesktopSentryLogger,
  type DesktopSentryPort,
  type DesktopSentryRuntime,
} from './desktop-sentry'

export interface CreateDesktopSentryBindingsOptions {
  runtime: DesktopSentryRuntime
  logger: DesktopSentryLogger
  loadSentryMain(): Promise<DesktopSentryPort>
  env?: NodeJS.ProcessEnv
}

export function createDesktopSentryBindings(
  options: CreateDesktopSentryBindingsOptions,
): DesktopSentryApi {
  // Keep the production fallback as a direct process.env access so the
  // Electron Vite build can replace the secret-backed value at build time.
  // Tests and alternate runtimes may still provide an explicit environment.
  const env = options.env

  return createDesktopSentry({
    dsn: env?.BITSENTRY_SENTRY_DSN ?? process.env.BITSENTRY_SENTRY_DSN ?? '',
    releaseChannel:
      env?.BITSENTRY_RELEASE_CHANNEL ?? process.env.BITSENTRY_RELEASE_CHANNEL ?? 'stable',
    runtime: options.runtime,
    logger: options.logger,
    loadSentryMain: () => options.loadSentryMain(),
  })
}
