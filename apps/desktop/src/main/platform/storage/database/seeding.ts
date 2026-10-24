import { createDesktopDatabaseSeeders } from '@bitsentry-ce/core/features/desktop/desktop-database-seeding'
import { configureDesktopDatabaseRuntime } from '@bitsentry-ce/desktop-cli/runtime/database-index'
import log from 'electron-log'

const desktopDatabaseSeeders = createDesktopDatabaseSeeders({
  defaultLlmProvider: 'codex',
  logger: log,
})

configureDesktopDatabaseRuntime(desktopDatabaseSeeders)
