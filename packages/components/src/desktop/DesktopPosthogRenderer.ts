import posthog from 'posthog-js/dist/module.full.no-external.js'
import {
  configureDesktopPosthogRuntime,
  type DesktopPosthogApi,
} from './DesktopPosthog'

type ConfigureDesktopPosthogRendererRuntimeInput = {
  posthogKey?: string
  posthogHost?: string
  productName?: string
}

let desktopPosthogApi: DesktopPosthogApi | null = null

export function configureDesktopPosthogRendererRuntime({
  posthogKey,
  posthogHost,
  productName,
}: ConfigureDesktopPosthogRendererRuntimeInput): DesktopPosthogApi {
  desktopPosthogApi = configureDesktopPosthogRuntime({
    posthogClient: posthog,
    posthogKey,
    posthogHost,
    productName,
  })

  return desktopPosthogApi
}

function getDesktopPosthogApi(): DesktopPosthogApi {
  if (desktopPosthogApi === null) {
    throw new Error('Desktop PostHog renderer runtime has not been configured')
  }

  return desktopPosthogApi
}

export async function initDesktopAnalytics(): Promise<void> {
  await getDesktopPosthogApi().initDesktopAnalytics()
}

export function syncDesktopAnalyticsUser(
  user: Parameters<DesktopPosthogApi['syncDesktopAnalyticsUser']>[0],
): void {
  getDesktopPosthogApi().syncDesktopAnalyticsUser(user)
}

export function captureDesktopAnalyticsEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  getDesktopPosthogApi().captureDesktopAnalyticsEvent(event, properties)
}

export function captureDesktopAnalyticsException(error: unknown): void {
  getDesktopPosthogApi().captureDesktopAnalyticsException(error)
}

export function captureDesktopPageview(path: string): void {
  getDesktopPosthogApi().captureDesktopPageview(path)
}
