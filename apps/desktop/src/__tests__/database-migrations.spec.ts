import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  closeDatabase,
  configureDesktopDatabaseRuntime,
  getDatabase,
  initializeDatabase,
} from '@bitsentry-ce/desktop-cli/runtime/database-index'
import { setRuntimeUserDataPath } from '@bitsentry-ce/desktop-cli/runtime/runtime-paths'

type BetterSqlite3Constructor = typeof import('better-sqlite3')

const CURRENT_SCHEMA_VERSION = 17
const tempDirectories: string[] = []
let Database: BetterSqlite3Constructor | undefined
let nativeModuleWarning: string | undefined

try {
  ({ default: Database } = await import('better-sqlite3') as unknown as {
    default: BetterSqlite3Constructor
  })
  const probe = new Database(':memory:')
  probe.close()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (!/NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(message)) {
    throw error
  }

  nativeModuleWarning = [
    'Skipping desktop SQLite migration specs because better-sqlite3 was built for Electron, not the Node runtime used by Vitest.',
    'Fix with: pnpm rebuild better-sqlite3',
    `Native loader error: ${message}`,
  ].join('\n')
  console.warn(nativeModuleWarning)
  Database = undefined
}

vi.setConfig({ testTimeout: 30_000 })

async function makeDatabaseDirectory(): Promise<{ directory: string; databasePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-db-upgrade-'))
  tempDirectories.push(directory)
  return { directory, databasePath: path.join(directory, 'bitsentry.db') }
}

function configureNoopSeeders(): void {
  configureDesktopDatabaseRuntime({
    seedDefaults: vi.fn(async () => {}),
    seedDemoData: vi.fn(async () => {}),
  })
}

function prepareOldestSupportedFixture(databasePath: string): void {
  const sqlite = newDatabase(databasePath)
  sqlite.exec(`
    CREATE TABLE "Setting" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "key" TEXT NOT NULL,
      "value" TEXT NOT NULL
    );
    INSERT INTO "Setting" ("key", "value") VALUES ('retained.setting', 'retained-value');
    PRAGMA user_version = 0;
  `)
  sqlite.close()
}

function newDatabase(databasePath: string): InstanceType<BetterSqlite3Constructor> {
  if (Database === undefined) {
    throw new Error(nativeModuleWarning ?? 'better-sqlite3 failed to load')
  }
  return new Database(databasePath)
}

async function migrationLedgerVersions(): Promise<number[]> {
  const rows = await getDatabase().$queryRawUnsafe<{ version: number }>(
    'SELECT "version" FROM "_MigrationLedger" ORDER BY "version" ASC',
  )
  return rows.map((row) => row.version)
}

afterEach(async () => {
  await closeDatabase()
  setRuntimeUserDataPath(null)
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

const describeSqliteMigrations = Database === undefined ? describe.skip : describe

describeSqliteMigrations('desktop SQLite upgrades', () => {
  it('upgrades the oldest supported fixture, preserves data, and reopens idempotently', async () => {
    const { directory, databasePath } = await makeDatabaseDirectory()
    prepareOldestSupportedFixture(databasePath)
    configureNoopSeeders()
    setRuntimeUserDataPath(directory)

    await initializeDatabase()
    const retainedRows = await getDatabase().$queryRawUnsafe<{ value: string }>(
      'SELECT "value" FROM "Setting" WHERE "key" = \'retained.setting\'',
    )
    const firstVersions = await migrationLedgerVersions()
    const firstUserVersion = await getDatabase().$queryRawUnsafe<{ user_version: number }>(
      'PRAGMA user_version',
    )

    expect(retainedRows).toEqual([{ value: 'retained-value' }])
    expect(firstVersions).toEqual(Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1))
    expect(firstUserVersion[0]?.user_version).toBe(CURRENT_SCHEMA_VERSION)

    await closeDatabase()
    await initializeDatabase()

    expect(await migrationLedgerVersions()).toEqual(firstVersions)
  })

  it('applies the immediately previous migration exactly once', async () => {
    const { directory, databasePath } = await makeDatabaseDirectory()
    prepareOldestSupportedFixture(databasePath)
    configureNoopSeeders()
    setRuntimeUserDataPath(directory)
    await initializeDatabase()
    await closeDatabase()

    const sqlite = newDatabase(databasePath)
    sqlite.exec(`
      DELETE FROM "_MigrationLedger" WHERE "version" = ${String(CURRENT_SCHEMA_VERSION)};
      PRAGMA user_version = ${String(CURRENT_SCHEMA_VERSION - 1)};
    `)
    sqlite.close()

    await initializeDatabase()
    expect(await migrationLedgerVersions()).toEqual(
      Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, index) => index + 1),
    )
  })

  it('fails closed and releases the database client when migration initialization fails', async () => {
    const { directory, databasePath } = await makeDatabaseDirectory()
    const sqlite = newDatabase(databasePath)
    sqlite.exec('CREATE TABLE "Setting" ("id" INTEGER PRIMARY KEY);')
    sqlite.close()
    configureNoopSeeders()
    setRuntimeUserDataPath(directory)

    await expect(initializeDatabase()).rejects.toThrow()
    expect(() => getDatabase()).toThrow('Database not initialized')
  })
})
