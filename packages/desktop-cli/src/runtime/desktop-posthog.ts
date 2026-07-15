import {
  getDesktopAnalyticsContext as getSharedDesktopAnalyticsContext,
  markDesktopFirstRunCaptured,
  type DesktopAnalyticsContext,
  type DesktopAnalyticsSettingsDb,
} from '@bitsentry-ce/core/features/analytics/desktop-posthog'
import { getRuntimeAppVersion } from './electron-app.js'

export {
  markDesktopFirstRunCaptured,
  type DesktopAnalyticsContext,
} from '@bitsentry-ce/core/features/analytics/desktop-posthog'

export function getDesktopAnalyticsContext(
  db: DesktopAnalyticsSettingsDb,
): Promise<DesktopAnalyticsContext> {
  return getSharedDesktopAnalyticsContext(db, { getRuntimeAppVersion })
}
