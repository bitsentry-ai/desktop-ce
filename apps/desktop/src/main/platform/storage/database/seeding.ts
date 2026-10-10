import { createDesktopDatabaseSeeders } from '@bitsentry-ce/core/features/desktop/desktop-database-seeding'
import { configureDesktopDatabaseRuntime } from '@bitsentry-ce/desktop-cli/runtime/database-index'
import log from 'electron-log'
import type { DbClient } from './client'

const desktopDatabaseSeeders = createDesktopDatabaseSeeders({
  defaultLlmProvider: 'codex',
  logger: log,
})

configureDesktopDatabaseRuntime(desktopDatabaseSeeders)

export async function seedDefaults(client: DbClient): Promise<void> {
  await desktopDatabaseSeeders.seedDefaults(client)
}
