import { randomUUID } from 'crypto'
import {
  isTelemetryEnabled,
  type DesktopTelemetrySettingsDb,
} from './desktop-telemetry-consent'

const INSTALLATION_ID_KEY = 'analytics.installationId'
const FIRST_LAUNCHED_AT_KEY = 'analytics.desktopFirstLaunchedAt'
const FIRST_RUN_CAPTURED_AT_KEY = 'analytics.desktopFirstRunCapturedAt'
const RELEASE_CHANNEL = process.env.BITSENTRY_RELEASE_CHANNEL ?? 'stable'

type SettingRecord = { value: string } | null

export interface DesktopAnalyticsContext {
  installationId: string | null
  telemetryEnabled: boolean
  shouldCaptureFirstRun: boolean
  appVersion: string
  releaseChannel: string
  platform: NodeJS.Platform
}

export type DesktopAnalyticsSettingsDb = DesktopTelemetrySettingsDb;

export interface DesktopAnalyticsRuntime {
  getRuntimeAppVersion(): string
}

async function findSetting(
  db: DesktopAnalyticsSettingsDb,
  key: string,
): Promise<SettingRecord> {
  const setting = await db.setting.findUnique({ where: { key } })
  if (setting === null || typeof setting.value !== 'string') {
    return null
  }

  return { value: setting.value }
}

async function upsertSetting(
  db: DesktopAnalyticsSettingsDb,
  key: string,
  value: string,
): Promise<void> {
  await db.setting.upsert({
    where: { key },
    update: { value, type: 'string' },
    create: { key, value, type: 'string' },
  })
}

async function getOrCreateInstallationId(db: DesktopAnalyticsSettingsDb): Promise<string> {
  const existing = await findSetting(db, INSTALLATION_ID_KEY)
  if (existing?.value !== undefined && existing.value.length > 0) {
    return existing.value
  }

  const installationId = randomUUID()
  await upsertSetting(db, INSTALLATION_ID_KEY, installationId)
  return installationId
}

async function hasRecordedFirstLaunch(db: DesktopAnalyticsSettingsDb): Promise<boolean> {
  const existing = await findSetting(db, FIRST_LAUNCHED_AT_KEY)
  return existing?.value !== undefined && existing.value.length > 0
}

export async function getDesktopAnalyticsContext(
  db: DesktopAnalyticsSettingsDb,
  runtime: DesktopAnalyticsRuntime,
): Promise<DesktopAnalyticsContext> {
  const [firstLaunchRecorded, firstRunCapturedAt, telemetryEnabled] = await Promise.all([
    hasRecordedFirstLaunch(db),
    findSetting(db, FIRST_RUN_CAPTURED_AT_KEY),
    isTelemetryEnabled(db),
  ])

  if (!telemetryEnabled) {
    if (!firstLaunchRecorded) {
      await upsertSetting(db, FIRST_LAUNCHED_AT_KEY, new Date().toISOString())
    }

    const appVersion = runtime.getRuntimeAppVersion()

    return {
      installationId: null,
      telemetryEnabled,
      shouldCaptureFirstRun: false,
      appVersion,
      releaseChannel: RELEASE_CHANNEL,
      platform: process.platform,
    }
  }

  const installationId = await getOrCreateInstallationId(db)
  const appVersion = runtime.getRuntimeAppVersion()

  return {
    installationId,
    telemetryEnabled,
    shouldCaptureFirstRun:
      !firstLaunchRecorded &&
      firstRunCapturedAt?.value === undefined,
    appVersion,
    releaseChannel: RELEASE_CHANNEL,
    platform: process.platform,
  }
}

export async function markDesktopFirstRunCaptured(
  db: DesktopAnalyticsSettingsDb,
): Promise<void> {
  const capturedAt = new Date().toISOString()
  await Promise.all([
    upsertSetting(db, FIRST_RUN_CAPTURED_AT_KEY, capturedAt),
    upsertSetting(db, FIRST_LAUNCHED_AT_KEY, capturedAt),
  ])
}
