import { afterEach, describe, expect, it, vi } from 'vitest'

type AnalyticsContext = {
  installationId: string | null
  telemetryEnabled: boolean
  shouldCaptureFirstRun: boolean
  appVersion: string
  releaseChannel: string
  platform: string
}

function setAnalyticsBridge(telemetryEnabled: boolean): void {
  const context: AnalyticsContext = {
    installationId: 'desktop-installation-test',
    telemetryEnabled,
    shouldCaptureFirstRun: false,
    appVersion: '0.0.0-test',
    releaseChannel: 'preview',
    platform: 'darwin',
  }

  Object.assign(globalThis, {
    window: {
      bitsentry: {
        analytics: {
          getContext: vi.fn().mockResolvedValue(context),
          markFirstRunCaptured: vi.fn().mockResolvedValue({ ok: true }),
        },
      },
    },
  })
}

describe('desktop PostHog exception capture', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
    vi.resetModules()
  })

  it('queues and captures a renderer exception after consented initialization', async () => {
    setAnalyticsBridge(true)
    const captureException = vi.fn()
    const posthog = await import('@bitsentry-ce/components/desktop/DesktopPosthog')
    const api = posthog.configureDesktopPosthogRuntime({
      posthogClient: {
        init: vi.fn(),
        identify: vi.fn(),
        capture: vi.fn(),
        captureException,
      },
      posthogKey: 'phc-test-key',
      posthogHost: 'https://eu.i.posthog.com',
    })
    const error = new Error('desktop dogfood exception')

    api.captureDesktopAnalyticsException(error)
    await api.initDesktopAnalytics()

    expect(captureException).toHaveBeenCalledWith(error)
  })

  it('does not capture exceptions without telemetry consent', async () => {
    setAnalyticsBridge(false)
    const captureException = vi.fn()
    const posthog = await import('@bitsentry-ce/components/desktop/DesktopPosthog')
    const api = posthog.configureDesktopPosthogRuntime({
      posthogClient: {
        init: vi.fn(),
        identify: vi.fn(),
        capture: vi.fn(),
        captureException,
      },
      posthogKey: 'phc-test-key',
    })

    api.captureDesktopAnalyticsException(new Error('consent-gated exception'))
    await api.initDesktopAnalytics()

    expect(captureException).not.toHaveBeenCalled()
  })
})
