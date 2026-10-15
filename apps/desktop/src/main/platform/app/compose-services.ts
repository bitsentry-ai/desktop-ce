import type { DbClient } from '../storage/database/client'
import {
  composeDesktopSettingsServices,
  type DesktopSettingsServices,
} from '@bitsentry-ce/desktop-cli/runtime/desktop-settings-services'

export type DesktopServices = DesktopSettingsServices

export function composeServices(db: DbClient): Promise<DesktopServices> {
  return Promise.resolve(composeDesktopSettingsServices(db))
}
