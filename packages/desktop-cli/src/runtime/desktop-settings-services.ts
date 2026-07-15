import {
  composeDesktopServices,
  type DesktopComposedServices,
  DesktopSqliteSettingsRepositoryAdapter,
  type DesktopSettingsRepositoryDatabase,
} from '@bitsentry-ce/core/features/settings'
import {
  createDesktopSchedulerJobRuntime,
  type DesktopJobRuntime,
  type DesktopJobRuntimeDatabase,
} from './desktop-job-runtime.js'

export type DesktopSettingsServiceDatabase =
  & DesktopJobRuntimeDatabase
  & DesktopSettingsRepositoryDatabase

export type DesktopSettingsServices<TExtraServices extends object = {}> =
  DesktopComposedServices<DesktopJobRuntime, TExtraServices>

export function composeDesktopSettingsServices(
  db: DesktopSettingsServiceDatabase,
): DesktopSettingsServices

export function composeDesktopSettingsServices<TExtraServices extends object>(
  db: DesktopSettingsServiceDatabase,
  options: {
    extraServices: TExtraServices
  },
): DesktopSettingsServices<TExtraServices>

export function composeDesktopSettingsServices<TExtraServices extends object>(
  db: DesktopSettingsServiceDatabase,
  options?: {
    extraServices?: TExtraServices
  },
) {
  if (options?.extraServices === undefined) {
    return composeDesktopServices({
      settingsRepository: new DesktopSqliteSettingsRepositoryAdapter(db),
      jobRuntime: createDesktopSchedulerJobRuntime(db),
    })
  }

  return composeDesktopServices({
    settingsRepository: new DesktopSqliteSettingsRepositoryAdapter(db),
    jobRuntime: createDesktopSchedulerJobRuntime(db),
    extraServices: options.extraServices,
  })
}
