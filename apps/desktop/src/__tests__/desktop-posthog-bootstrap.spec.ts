import { beforeEach, describe, expect, it, vi } from 'vitest'

const EXPECTED_APP_VERSION = process.env.npm_package_version ?? '0.0.0'

const importPostHogModule = async (releaseChannel = 'stable') => {
  vi.resetModules()
  process.env.BITSENTRY_RELEASE_CHANNEL = releaseChannel
  return import('@bitsentry-ce/desktop-cli/runtime/desktop-posthog')
}

function createDb(
  values: Record<string, string | undefined> = {},
) {
  const stored = new Map(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] != null),
  )

  return {
    setting: {
      findUnique: vi.fn(({ where: { key } }: { where: { key: string } }) => {
        const value = stored.get(key)
        if (value === undefined) {
          return Promise.resolve(null)
        }

        return Promise.resolve({ key, value })
      }),
      upsert: vi.fn(({
        where: { key },
        update,
      }: {
        where: { key: string }
        update: { value: string }
        create: { value: string }
      }) => {
        const value = update.value
        stored.set(key, value)
        return Promise.resolve({ key, value })
      }),
    },
    getSetting(key: string) {
      return stored.get(key)
    },
  }
}

describe('desktop PostHog bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.BITSENTRY_RELEASE_CHANNEL
  })

  it('creates a persistent installation id and leaves first-run capture pending until acknowledgement', async () => {
    const analytics = await importPostHogModule('preview')
    const db = createDb()

    const context = await analytics.getDesktopAnalyticsContext(db)

    expect(context.installationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    expect(context.telemetryEnabled).toBe(true)
    expect(context.shouldCaptureFirstRun).toBe(true)
    expect(context.appVersion).toBe(EXPECTED_APP_VERSION)
    expect(context.releaseChannel).toBe('preview')
    expect(context.platform).toBe(process.platform)
    expect(db.getSetting('analytics.desktopFirstLaunchedAt')).toBeUndefined()
  })

  it('reuses the stored installation id and suppresses first-run recapture after acknowledgement', async () => {
    const analytics = await importPostHogModule()
    const db = createDb({
      'analytics.installationId': 'install-123',
      'analytics.desktopFirstRunCapturedAt': '2026-05-16T00:00:00.000Z',
      'telemetry.enabled': 'true',
    })

    const context = await analytics.getDesktopAnalyticsContext(db)

    expect(context.installationId).toBe('install-123')
    expect(context.telemetryEnabled).toBe(true)
    expect(context.shouldCaptureFirstRun).toBe(false)
  })

  it('keeps telemetry disabled by default on stable builds without a saved setting', async () => {
    const analytics = await importPostHogModule('stable')
    const db = createDb()

    const context = await analytics.getDesktopAnalyticsContext(db)

    expect(context.installationId).toBeNull()
    expect(context.telemetryEnabled).toBe(false)
  })

  it('does not backfill desktop_first_run after a stable user opts in later', async () => {
    const analytics = await importPostHogModule('stable')
    const db = createDb()

    const firstLaunchContext = await analytics.getDesktopAnalyticsContext(db)
    expect(firstLaunchContext.telemetryEnabled).toBe(false)
    expect(firstLaunchContext.shouldCaptureFirstRun).toBe(false)

    await db.setting.upsert({
      where: { key: 'telemetry.enabled' },
      update: { value: 'true' },
      create: { value: 'true' },
    })

    const optedInContext = await analytics.getDesktopAnalyticsContext(db)
    expect(optedInContext.telemetryEnabled).toBe(true)
    expect(optedInContext.shouldCaptureFirstRun).toBe(false)
  })

  it('retries desktop_first_run on the next launch until the first run is acknowledged', async () => {
    const analytics = await importPostHogModule('preview')
    const db = createDb()

    const firstAttempt = await analytics.getDesktopAnalyticsContext(db)
    const secondAttempt = await analytics.getDesktopAnalyticsContext(db)

    expect(firstAttempt.shouldCaptureFirstRun).toBe(true)
    expect(secondAttempt.shouldCaptureFirstRun).toBe(true)
    expect(db.getSetting('analytics.desktopFirstLaunchedAt')).toBeUndefined()
  })

  it('stores the first-run acknowledgement timestamp', async () => {
    const analytics = await importPostHogModule()
    const db = createDb()

    await analytics.markDesktopFirstRunCaptured(db)

    expect(db.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'analytics.desktopFirstRunCapturedAt' },
      }),
    )
    expect(db.setting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'analytics.desktopFirstLaunchedAt' },
      }),
    )
  })
})
