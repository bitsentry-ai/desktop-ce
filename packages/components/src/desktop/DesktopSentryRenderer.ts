import { configureDesktopSentryRuntime } from './DesktopSentry'

export const {
  initSentryRenderer,
  captureRendererException,
  DesktopRouteTracing,
} = configureDesktopSentryRuntime({
  loadSentryRuntime: async () => (await import('./DesktopSentryRendererRuntime')).default,
})
