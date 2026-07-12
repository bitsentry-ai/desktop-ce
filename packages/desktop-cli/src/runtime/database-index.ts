import log from 'electron-log'
import { mkdir } from 'fs/promises'
import path from 'path'
import { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import {
  createDatabaseSnapshot,
  isDatabaseBackupEnabled,
  restoreDatabaseSnapshot,
} from './database-backups.js'
import { getDatabasePath, getDatabaseUrl } from './database-paths.js'

let db: DbClient | null = null
const DATABASE_SCHEMA_VERSION = 16

export type DesktopDatabaseRuntimeSeeders = {
  seedDefaults(client: DbClient): Promise<void>
  seedDemoData(client: DbClient): Promise<void>
}

let configuredSeeders: DesktopDatabaseRuntimeSeeders | null = null

export function configureDesktopDatabaseRuntime(seeders: DesktopDatabaseRuntimeSeeders): void {
  configuredSeeders = seeders
}

function getConfiguredSeeders(): DesktopDatabaseRuntimeSeeders {
  if (configuredSeeders === null) {
    throw new Error('Desktop database runtime has not been configured')
  }

  return configuredSeeders
}

function getDb(): DbClient {
  if (db === null) {
    throw new Error('Database has not been initialized')
  }

  return db
}

export async function initializeDatabase(): Promise<DbClient> {
  if (db !== null) return db

  const seeders = getConfiguredSeeders()
  const databasePath = getDatabasePath()
  const databaseUrl = getDatabaseUrl()
  await mkdir(path.dirname(databasePath), { recursive: true })
  let backupPath: string | null = null
  if (isDatabaseBackupEnabled()) {
    backupPath = await createDatabaseSnapshot(databasePath)
  }
  log.info(`[database] Initializing SQLite at ${databasePath}`)

  let logLevels = ['error']
  if (process.env.NODE_ENV === 'development') {
    logLevels = ['warn', 'error']
  }

  db = new DbClient({
    datasources: { db: { url: databaseUrl } },
    log: logLevels,
  })

  try {
    await db.$connect()
    log.info('[database] Connected to SQLite')

    await db.$executeRawUnsafe('PRAGMA journal_mode = WAL')
    await db.$executeRawUnsafe('PRAGMA synchronous = FULL')
    await db.$executeRawUnsafe('PRAGMA foreign_keys = ON')
    await db.$executeRawUnsafe('PRAGMA busy_timeout = 5000')

    await assertDatabaseIntegrity()
    await runMigrations()
    await assertDatabaseIntegrity()

    await seeders.seedDefaults(db)
    await seeders.seedDemoData(db)
  } catch (error) {
    log.error('[database] Initialization failed:', error)
    if (backupPath !== null) {
      try {
        await getDb().$disconnect()
        await restoreDatabaseSnapshot(backupPath, databasePath)
        db = new DbClient({
          datasources: { db: { url: databaseUrl } },
          log: logLevels,
        })
        await getDb().$connect()
        await getDb().$executeRawUnsafe('PRAGMA journal_mode = WAL')
        await getDb().$executeRawUnsafe('PRAGMA synchronous = FULL')
        await getDb().$executeRawUnsafe('PRAGMA foreign_keys = ON')
        await getDb().$executeRawUnsafe('PRAGMA busy_timeout = 5000')
        log.warn('[database] Recovery path executed after failed migration')
      } catch (restoreError) {
        log.error('[database] Failed to restore snapshot:', restoreError)
      }
    }
    throw error
  }

  return db
}

async function assertDatabaseIntegrity(): Promise<void> {
  const rows = await getDb().$queryRawUnsafe<{ integrity_check?: string }>(
    'PRAGMA integrity_check(1)',
  )
  const result = rows[0]?.integrity_check
  if (result !== 'ok') {
    throw new Error(`SQLite integrity check failed: ${result ?? 'unknown result'}`)
  }
}

async function ensureMigrationLedger(): Promise<void> {
  await getDb().$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_MigrationLedger" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "version" INTEGER NOT NULL,
      "name" TEXT NOT NULL,
      "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
  await getDb().$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "_MigrationLedger_version_key" ON "_MigrationLedger"("version")
  `)
}

async function getAppliedMigrationVersions(): Promise<Set<number>> {
  const rows = await getDb().$queryRawUnsafe<{ version: number }>(
    'SELECT "version" FROM "_MigrationLedger"',
  )
  return new Set(rows.map((row: { version: number }) => row.version))
}

async function markMigrationApplied(version: number, name: string): Promise<void> {
  await getDb().$executeRawUnsafe(`
    INSERT OR IGNORE INTO "_MigrationLedger" ("version", "name")
    VALUES (${String(version)}, '${name.replace(/'/g, "''")}')
  `)
}

function isDuplicateColumnError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /duplicate column name/i.test(error.message)
}

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const rows = await getDb().$queryRawUnsafe<{ name?: unknown }>(
    `PRAGMA table_info("${tableName.replace(/"/g, '""')}")`,
  )
  const names = rows.flatMap((row: { name?: unknown }) => {
    if (typeof row.name !== 'string') {
      return []
    }

    const name = row.name.trim()
    if (name.length === 0) {
      return []
    }

    return [name]
  })
  return new Set(names)
}

interface LegacyRunbookVersionRow extends Record<string, unknown> {
  id?: string
  runbookId?: string
  actionsJson?: string
  updatedAt?: string
}

interface LegacyRunbookActionRow extends Record<string, unknown> {
  id?: unknown
  type?: unknown
  title?: unknown
  command?: unknown
  prompt?: unknown
  llmProviderKey?: unknown
  llmModel?: unknown
  url?: unknown
  method?: unknown
  headers?: unknown
  headersJson?: unknown
  body?: unknown
  query?: unknown
  sourceId?: unknown
  parameters?: unknown
  parametersJson?: unknown
  logFilter?: unknown
  logFilterJson?: unknown
}

function safeParseLegacyRunbookActions(value: unknown): LegacyRunbookActionRow[] {
  if (typeof value !== 'string' || value.trim().length === 0) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(
      (item): item is LegacyRunbookActionRow =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    )
  } catch {
    return []
  }
}

function legacyString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') {
    return fallback
  }

  return value
}

function escapedSqlString(value: string): string {
  return value.replace(/'/g, "''")
}

function legacySqlString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  return escapedSqlString(value)
}

function sqlStringLiteral(value: string | null): string {
  if (value === null) {
    return 'NULL'
  }

  return `'${value}'`
}

function legacyJsonString(primary: unknown, fallback: unknown): string | null {
  if (Array.isArray(primary)) {
    return escapedSqlString(JSON.stringify(primary))
  }

  return legacySqlString(fallback)
}

function legacyObjectJsonString(primary: unknown, fallback: unknown): string | null {
  if (typeof primary === 'object' && primary !== null && !Array.isArray(primary)) {
    return escapedSqlString(JSON.stringify(primary))
  }

  return legacySqlString(fallback)
}

function legacyUpdatedAt(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }

  return new Date().toISOString()
}

function legacyActionId(action: LegacyRunbookActionRow, runbookId: string, index: number): string {
  if (typeof action.id === 'string' && action.id.trim().length > 0) {
    return action.id
  }

  return `${runbookId}:action:${String(index + 1)}`
}

async function insertLegacyRunbookAction(
  runbookId: string,
  action: LegacyRunbookActionRow,
  index: number,
  updatedAt: string,
): Promise<void> {
  const id = legacyActionId(action, runbookId, index)
  const type = legacyString(action.type, 'shell')
  const title = legacyString(action.title)
  const command = legacySqlString(action.command)
  const prompt = legacySqlString(action.prompt)
  const llmProviderKey = legacySqlString(action.llmProviderKey)
  const llmModel = legacySqlString(action.llmModel)
  const url = legacySqlString(action.url)
  const method = legacySqlString(action.method)
  const headersJson = legacyJsonString(action.headers, action.headersJson)
  const body = legacySqlString(action.body)
  const query = legacySqlString(action.query)
  const sourceId = legacySqlString(action.sourceId)
  const parametersJson = legacyJsonString(action.parameters, action.parametersJson)
  const logFilterJson = legacyObjectJsonString(action.logFilter, action.logFilterJson)

  await getDb().$executeRawUnsafe(`
    INSERT OR IGNORE INTO "RunbookAction" (
      "id",
      "runbookId",
      "sortOrder",
      "type",
      "title",
      "command",
      "prompt",
      "llmProviderKey",
      "llmModel",
      "url",
      "method",
      "headersJson",
      "body",
      "query",
      "sourceId",
      "parametersJson",
      "logFilterJson",
      "createdAt",
      "updatedAt"
    ) VALUES (
      '${escapedSqlString(id)}',
      '${escapedSqlString(runbookId)}',
      ${String(index)},
      '${escapedSqlString(type)}',
      '${escapedSqlString(title)}',
      ${sqlStringLiteral(command)},
      ${sqlStringLiteral(prompt)},
      ${sqlStringLiteral(llmProviderKey)},
      ${sqlStringLiteral(llmModel)},
      ${sqlStringLiteral(url)},
      ${sqlStringLiteral(method)},
      ${sqlStringLiteral(headersJson)},
      ${sqlStringLiteral(body)},
      ${sqlStringLiteral(query)},
      ${sqlStringLiteral(sourceId)},
      ${sqlStringLiteral(parametersJson)},
      ${sqlStringLiteral(logFilterJson)},
      '${escapedSqlString(updatedAt)}',
      '${escapedSqlString(updatedAt)}'
    )
  `)
}

async function backfillLegacyRunbookVersion(
  version: LegacyRunbookVersionRow,
  hydratedRunbookIds: Set<string>,
): Promise<void> {
  const runbookId = legacyString(version.runbookId)
  if (runbookId.length === 0 || hydratedRunbookIds.has(runbookId)) return

  const actions = safeParseLegacyRunbookActions(version.actionsJson)
  const updatedAt = legacyUpdatedAt(version.updatedAt)

  for (let index = 0; index < actions.length; index += 1) {
    await insertLegacyRunbookAction(runbookId, actions[index], index, updatedAt)
  }

  hydratedRunbookIds.add(runbookId)
}

async function backfillRunbookActionsFromLegacyVersions(): Promise<void> {
  const actionCountRows = await getDb().$queryRawUnsafe<{ count?: number | string }>(
    'SELECT COUNT(*) as "count" FROM "RunbookAction"',
  )
  const existingActionCount = Number(actionCountRows[0]?.count ?? 0)
  if (existingActionCount > 0) {
    return
  }

  const legacyVersions = await getDb().$queryRawUnsafe<LegacyRunbookVersionRow>(
    'SELECT "id", "runbookId", "actionsJson", "updatedAt" FROM "RunbookVersion" ORDER BY "versionNumber" DESC',
  )

  const hydratedRunbookIds = new Set<string>()

  for (const version of legacyVersions) {
    await backfillLegacyRunbookVersion(version, hydratedRunbookIds)
  }
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity -- Idempotent schema sync intentionally lists independent migration steps.
async function runMigrations(): Promise<void> {
  await ensureMigrationLedger()
  const appliedVersions = await getAppliedMigrationVersions()

  // Desktop ships with Drizzle + better-sqlite3. We keep startup schema sync
  // lightweight by running idempotent SQL at app boot.
  try {
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Role" (
        "id" INTEGER NOT NULL PRIMARY KEY,
        "name" TEXT
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Status" (
        "id" INTEGER NOT NULL PRIMARY KEY,
        "name" TEXT
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "email" TEXT,
        "password" TEXT,
        "firstName" TEXT,
        "lastName" TEXT,
        "provider" TEXT NOT NULL DEFAULT 'email',
        "roleId" INTEGER,
        "statusId" INTEGER,
        "lastLoginAt" DATETIME,
        "totpSecret" TEXT,
        "totpEnabled" BOOLEAN NOT NULL DEFAULT 0,
        "totpBackupCodes" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "deletedAt" DATETIME,
        CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "User_statusId_fkey" FOREIGN KEY ("statusId") REFERENCES "Status" ("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Session" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "userId" INTEGER NOT NULL,
        "hash" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "deletedAt" DATETIME,
        CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Setting" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Setting_key_key" ON "Setting"("key")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AuditLog" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "action" TEXT NOT NULL,
        "userId" INTEGER,
        "details" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Phase 3: Security operations tables
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Agent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "description" TEXT,
        "type" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'OFFLINE',
        "version" TEXT NOT NULL DEFAULT '1.0.0',
        "hostname" TEXT,
        "ipAddress" TEXT,
        "operatingSystem" TEXT,
        "configuration" TEXT,
        "capabilities" TEXT NOT NULL DEFAULT '[]',
        "lastHeartbeat" DATETIME,
        "lastSeen" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "deletedAt" DATETIME
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AgentHealth" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "agentId" TEXT NOT NULL,
        "cpuUsage" REAL,
        "memoryUsage" REAL,
        "diskUsage" REAL,
        "networkIn" REAL,
        "networkOut" REAL,
        "uptime" REAL,
        "errors" TEXT,
        "warnings" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "AgentHealth_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "AgentHealth_agentId_key" ON "AgentHealth"("agentId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AgentTag" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "agentId" TEXT NOT NULL,
        "key" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AgentTag_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "AgentTag_agentId_idx" ON "AgentTag"("agentId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Vulnerability" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "severity" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'OPEN',
        "cvssScore" REAL,
        "cveId" TEXT,
        "source" TEXT,
        "affectedAsset" TEXT,
        "remediation" TEXT,
        "assignedToId" INTEGER,
        "falsePositiveJustification" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        "deletedAt" DATETIME
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "VulnerabilityAgent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "vulnerabilityId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        CONSTRAINT "VulnerabilityAgent_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "VulnerabilityAgent_vulnerabilityId_agentId_key" ON "VulnerabilityAgent"("vulnerabilityId", "agentId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "VulnerabilityAgent_agentId_idx" ON "VulnerabilityAgent"("agentId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "VulnerabilityTimeline" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "vulnerabilityId" TEXT NOT NULL,
        "action" TEXT NOT NULL,
        "comment" TEXT,
        "userId" INTEGER,
        "oldStatus" TEXT,
        "newStatus" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "VulnerabilityTimeline_vulnerabilityId_fkey" FOREIGN KEY ("vulnerabilityId") REFERENCES "Vulnerability" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "VulnerabilityTimeline_vulnerabilityId_idx" ON "VulnerabilityTimeline"("vulnerabilityId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ThreatIntelligence" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "source" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "severity" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "mitre" TEXT,
        "confidence" INTEGER,
        "active" BOOLEAN NOT NULL DEFAULT 1,
        "expiresAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ThreatIndicator" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "threatId" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "value" TEXT NOT NULL,
        "description" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ThreatIndicator_threatId_fkey" FOREIGN KEY ("threatId") REFERENCES "ThreatIntelligence" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ThreatIndicator_threatId_idx" ON "ThreatIndicator"("threatId")
    `)

    // Phase 4: Extend Setting table with new columns (ALTER TABLE ADD COLUMN is safe to retry)
    const settingAlterColumns = [
      { name: 'type', sql: `ALTER TABLE "Setting" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'string'` },
      { name: 'description', sql: `ALTER TABLE "Setting" ADD COLUMN "description" TEXT` },
      { name: 'userId', sql: `ALTER TABLE "Setting" ADD COLUMN "userId" INTEGER` },
      { name: 'createdAt', sql: `ALTER TABLE "Setting" ADD COLUMN "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` },
      { name: 'updatedAt', sql: `ALTER TABLE "Setting" ADD COLUMN "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP` },
    ]
    for (const col of settingAlterColumns) {
      try {
        await getDb().$executeRawUnsafe(col.sql)
      } catch {
        // Column already exists — ignore duplicate column errors
      }
    }

    // Phase 4: Integration tables
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Integration" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'INACTIVE',
        "configuration" TEXT NOT NULL DEFAULT '{}',
        "credentials" TEXT,
        "lastSync" DATETIME,
        "errors" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "IntegrationHealth" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "integrationId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'unknown',
        "responseTime" REAL,
        "lastChecked" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "errors" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "IntegrationHealth_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationHealth_integrationId_key" ON "IntegrationHealth"("integrationId")
    `)

    // Phase 5: Error source integration tables
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ErrorSource" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sourceType" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "accessTokenRef" TEXT,
        "refreshTokenRef" TEXT,
        "expiresAt" DATETIME,
        "grantedScopes" TEXT NOT NULL DEFAULT '[]',
        "configuration" TEXT NOT NULL DEFAULT '{}',
        "logLevelThreshold" TEXT NOT NULL DEFAULT 'error',
        "additionalMetadata" TEXT,
        "syncEnabled" BOOLEAN NOT NULL DEFAULT 1,
        "autoDiagnosisEnabled" BOOLEAN NOT NULL DEFAULT 0,
        "lastSyncAt" DATETIME,
        "lastSyncStatus" TEXT,
        "lastSyncError" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorSource_sourceType_idx" ON "ErrorSource"("sourceType")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorSource_syncEnabled_idx" ON "ErrorSource"("syncEnabled")
    `)
    const errorSourceColumns = await getTableColumns('ErrorSource')
    if (!errorSourceColumns.has('logLevelThreshold')) {
      await getDb().$executeRawUnsafe(`
        ALTER TABLE "ErrorSource" ADD COLUMN "logLevelThreshold" TEXT NOT NULL DEFAULT 'error'
      `)
    }
    if (!errorSourceColumns.has('additionalMetadata')) {
      await getDb().$executeRawUnsafe(`
        ALTER TABLE "ErrorSource" ADD COLUMN "additionalMetadata" TEXT
      `)
    }
    await getDb().$executeRawUnsafe(`
      UPDATE "ErrorSource"
      SET "logLevelThreshold" = 'error'
      WHERE "logLevelThreshold" IS NULL OR trim("logLevelThreshold") = ''
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ErrorIssue" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        "externalIssueId" TEXT NOT NULL,
        "externalShortId" TEXT,
        "title" TEXT NOT NULL,
        "culprit" TEXT,
        "type" TEXT,
        "metadata" TEXT,
        "projectIdentifier" TEXT,
        "level" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'unresolved',
        "isUnhandled" BOOLEAN,
        "firstSeen" DATETIME NOT NULL,
        "lastSeen" DATETIME NOT NULL,
        "eventCount" INTEGER NOT NULL DEFAULT 1,
        "userCount" INTEGER,
        "tags" TEXT,
        "environment" TEXT,
        "release" TEXT,
        "platform" TEXT,
        "additionalMetadata" TEXT,
        "diagnosisStatus" TEXT,
        "diagnosisResult" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "ErrorIssue_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ErrorSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ErrorIssue_sourceId_externalIssueId_key" ON "ErrorIssue"("sourceId", "externalIssueId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorIssue_source_project_idx" ON "ErrorIssue"("sourceId", "projectIdentifier")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorIssue_status_idx" ON "ErrorIssue"("status")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorIssue_lastSeen_idx" ON "ErrorIssue"("lastSeen")
    `)
    const errorIssueColumns = await getTableColumns('ErrorIssue')
    if (!errorIssueColumns.has('additionalMetadata')) {
      await getDb().$executeRawUnsafe(`
        ALTER TABLE "ErrorIssue" ADD COLUMN "additionalMetadata" TEXT
      `)
    }
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ErrorEvent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "sourceId" TEXT NOT NULL,
        "issueId" TEXT NOT NULL,
        "externalEventId" TEXT NOT NULL,
        "timestamp" DATETIME NOT NULL,
        "message" TEXT,
        "exceptionType" TEXT,
        "exceptionValue" TEXT,
        "exceptionMechanism" TEXT,
        "stacktrace" TEXT,
        "inAppFrames" TEXT,
        "tags" TEXT,
        "contexts" TEXT,
        "userContext" TEXT,
        "requestContext" TEXT,
        "environment" TEXT,
        "release" TEXT,
        "serverName" TEXT,
        "traceId" TEXT,
        "requestId" TEXT,
        "transactionName" TEXT,
        "additionalMetadata" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "ErrorEvent_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ErrorSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "ErrorEvent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "ErrorIssue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ErrorEvent_sourceId_externalEventId_key" ON "ErrorEvent"("sourceId", "externalEventId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorEvent_issue_timestamp_idx" ON "ErrorEvent"("issueId", "timestamp")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorEvent_traceId_idx" ON "ErrorEvent"("traceId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorEvent_requestId_idx" ON "ErrorEvent"("requestId")
    `)
    const errorEventColumns = await getTableColumns('ErrorEvent')
    if (!errorEventColumns.has('additionalMetadata')) {
      await getDb().$executeRawUnsafe(`
        ALTER TABLE "ErrorEvent" ADD COLUMN "additionalMetadata" TEXT
      `)
    }

    // Phase 4: Ticket table
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Ticket" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "status" TEXT NOT NULL DEFAULT 'NEW',
        "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
        "externalTicketId" TEXT,
        "externalTicketNumber" TEXT,
        "ticketProvider" TEXT NOT NULL DEFAULT 'local',
        "ticketUrl" TEXT,
        "vulnerabilityId" TEXT,
        "incidentId" TEXT,
        "diagnosisId" INTEGER,
        "automatic" BOOLEAN NOT NULL DEFAULT 0,
        "resolutionType" TEXT,
        "resolutionNotes" TEXT,
        "lessonsLearned" TEXT,
        "resolvedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Ticket_vulnerabilityId_idx" ON "Ticket"("vulnerabilityId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Ticket_status_idx" ON "Ticket"("status")
    `)

    // Phase 5: JobRun table
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "JobRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "type" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'queued',
        "payload" TEXT,
        "result" TEXT,
        "error" TEXT,
        "attempt" INTEGER NOT NULL DEFAULT 0,
        "maxAttempts" INTEGER NOT NULL DEFAULT 3,
        "timeoutMs" INTEGER NOT NULL DEFAULT 300000,
        "scheduledAt" DATETIME,
        "startedAt" DATETIME,
        "completedAt" DATETIME,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "JobRun_status_idx" ON "JobRun"("status")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "JobRun_type_idx" ON "JobRun"("type")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "JobRun_scheduledAt_idx" ON "JobRun"("scheduledAt")
    `)

    // Phase 5: Report table
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Report" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "format" TEXT NOT NULL DEFAULT 'PDF',
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "parameters" TEXT,
        "content" TEXT,
        "filePath" TEXT,
        "scheduledAt" DATETIME,
        "completedAt" DATETIME,
        "userId" INTEGER,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Report_status_idx" ON "Report"("status")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Report_type_idx" ON "Report"("type")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Report_userId_idx" ON "Report"("userId")
    `)

    // Phase 5: Scan table
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Scan" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "type" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'PENDING',
        "target" TEXT,
        "configuration" TEXT,
        "results" TEXT,
        "summary" TEXT,
        "progress" INTEGER DEFAULT 0,
        "startedAt" DATETIME,
        "completedAt" DATETIME,
        "jobRunId" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Scan_status_idx" ON "Scan"("status")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Scan_jobRunId_idx" ON "Scan"("jobRunId")
    `)

    // Gate 3: Telemetry + diagnosis + CVE persistence
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TelemetryDaily" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "telemetryDate" TEXT NOT NULL,
        "currentState" TEXT NOT NULL DEFAULT 'pending',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryDaily_telemetryDate_key" ON "TelemetryDaily"("telemetryDate")
    `)

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TelemetryEntry" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "telemetryId" INTEGER NOT NULL,
        "entryId" TEXT,
        "entryIndex" TEXT,
        "entryScore" REAL,
        "entrySource" TEXT,
        "entryTimestamp" DATETIME NOT NULL,
        "fullLog" TEXT NOT NULL,
        "decoderName" TEXT,
        "location" TEXT,
        "agentName" TEXT,
        "agentIp" TEXT,
        "ruleId" INTEGER,
        "ruleDescription" TEXT,
        "ruleLevel" INTEGER,
        "processName" TEXT,
        "inputType" TEXT,
        "hostname" TEXT,
        "groups" TEXT,
        "ruleGroups" TEXT,
        "category" TEXT NOT NULL DEFAULT 'unknown',
        "state" TEXT NOT NULL DEFAULT 'pending',
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "TelemetryEntry_entryTimestamp_idx" ON "TelemetryEntry"("entryTimestamp")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "TelemetryEntry_state_idx" ON "TelemetryEntry"("state")
    `)
    const baseTelemetryColumns = await getTableColumns('TelemetryEntry')
    if (baseTelemetryColumns.has('entryId')) {
      await getDb().$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryEntry_telemetryId_entryId_key" ON "TelemetryEntry"("telemetryId", "entryId")
      `)
    }

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisEntry" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "telemetryEntryId" INTEGER,
        "currentState" TEXT NOT NULL DEFAULT 'pending',
        "stateHistory" TEXT NOT NULL DEFAULT '[]',
        "stateTexts" TEXT NOT NULL DEFAULT '{}',
        "sourceCategory" TEXT NOT NULL DEFAULT 'telemetry',
        "sourceKind" TEXT NOT NULL DEFAULT 'telemetry_entry',
        "logLevel" TEXT NOT NULL DEFAULT 'infrastructure',
        "severity" TEXT NOT NULL DEFAULT 'unknown',
        "category" TEXT NOT NULL DEFAULT 'unknown',
        "categoryConfidence" REAL,
        "description" TEXT,
        "environment" TEXT,
        "sourceMetadata" TEXT,
        "normalizedData" TEXT,
        "verificationData" TEXT,
        "debugPayload" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisEntry_telemetryEntryId_fkey" FOREIGN KEY ("telemetryEntryId") REFERENCES "TelemetryEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisEntrySourceRef" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "diagnosisEntryId" INTEGER NOT NULL,
        "sourceTableName" TEXT NOT NULL,
        "sourceFieldName" TEXT NOT NULL,
        "sourceKeyValue" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisEntrySourceRef_diagnosisEntryId_fkey" FOREIGN KEY ("diagnosisEntryId") REFERENCES "DiagnosisEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisEntry_telemetryEntryId_key" ON "DiagnosisEntry"("telemetryEntryId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisEntrySourceRef_diagnosisEntryId_key" ON "DiagnosisEntrySourceRef"("diagnosisEntryId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DiagnosisEntrySourceRef_lookup_idx" ON "DiagnosisEntrySourceRef"("sourceTableName", "sourceFieldName", "sourceKeyValue")
    `)

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CveEntry" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "summary" TEXT,
        "severity" TEXT,
        "cvssScore" REAL,
        "publishedAt" DATETIME,
        "lastModifiedAt" DATETIME,
        "references" TEXT,
        "metadata" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "CveEntry_severity_idx" ON "CveEntry"("severity")
    `)

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TelemetryCveLink" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "telemetryEntryId" INTEGER NOT NULL,
        "cveId" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "TelemetryCveLink_telemetryEntryId_fkey" FOREIGN KEY ("telemetryEntryId") REFERENCES "TelemetryEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "TelemetryCveLink_cveId_fkey" FOREIGN KEY ("cveId") REFERENCES "CveEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryCveLink_telemetryEntryId_cveId_key" ON "TelemetryCveLink"("telemetryEntryId", "cveId")
    `)

    // Gate 3: schedule registry base table (logic is implemented in Gate 5)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "JobSchedule" (
        "jobKey" TEXT NOT NULL PRIMARY KEY,
        "cronExpression" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT 1,
        "lastRunAt" DATETIME,
        "nextRunAt" DATETIME,
        "catchUpWindowHours" INTEGER NOT NULL DEFAULT 24,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL
      )
    `)

    // Gate 4: Worker-core parity alignment for desktop runtime
    const telemetryEntryAlterColumns = [
      { sql: `ALTER TABLE "TelemetryEntry" ADD COLUMN "entryId" TEXT` },
      { sql: `ALTER TABLE "TelemetryEntry" ADD COLUMN "entryIndex" TEXT` },
      { sql: `ALTER TABLE "TelemetryEntry" ADD COLUMN "entryScore" REAL` },
      { sql: `ALTER TABLE "TelemetryEntry" ADD COLUMN "entrySource" TEXT` },
      { sql: `ALTER TABLE "TelemetryEntry" ADD COLUMN "ruleGroups" TEXT` },
    ]
    for (const col of telemetryEntryAlterColumns) {
      try {
        await getDb().$executeRawUnsafe(col.sql)
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error
        }
      }
    }

    const diagnosisEntryAlterColumns = [
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "currentState" TEXT NOT NULL DEFAULT 'pending'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "sourceCategory" TEXT NOT NULL DEFAULT 'telemetry'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'telemetry_entry'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "logLevel" TEXT NOT NULL DEFAULT 'infrastructure'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'unknown'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'unknown'` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "categoryConfidence" REAL` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "description" TEXT` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "environment" TEXT` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "sourceMetadata" TEXT` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "normalizedData" TEXT` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "verificationData" TEXT` },
      { sql: `ALTER TABLE "DiagnosisEntry" ADD COLUMN "debugPayload" TEXT` },
    ]
    for (const col of diagnosisEntryAlterColumns) {
      try {
        await getDb().$executeRawUnsafe(col.sql)
      } catch (error) {
        if (!isDuplicateColumnError(error)) {
          throw error
        }
      }
    }

    const telemetryColumns = await getTableColumns('TelemetryEntry')
    if (telemetryColumns.has('entryId')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "TelemetryEntry"
        SET "entryId" = COALESCE(NULLIF("entryId", ''), CAST("id" AS TEXT))
        WHERE "entryId" IS NULL OR "entryId" = ''
      `)
    }
    if (telemetryColumns.has('entryIndex')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "TelemetryEntry"
        SET "entryIndex" = COALESCE(NULLIF("entryIndex", ''), NULLIF("hostname", ''), 'desktop-local')
        WHERE "entryIndex" IS NULL OR "entryIndex" = ''
      `)
    }
    if (telemetryColumns.has('entrySource')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "TelemetryEntry"
        SET "entrySource" = COALESCE(NULLIF("entrySource", ''), NULLIF("fullLog", ''), '{}')
        WHERE "entrySource" IS NULL OR "entrySource" = ''
      `)
    }
    if (telemetryColumns.has('ruleGroups')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "TelemetryEntry"
        SET "ruleGroups" = COALESCE(NULLIF("ruleGroups", ''), NULLIF("groups", ''), '[]')
        WHERE "ruleGroups" IS NULL OR "ruleGroups" = ''
      `)
    }

    await getDb().$executeRawUnsafe(`
      INSERT OR IGNORE INTO "TelemetryDaily" ("telemetryDate", "currentState", "createdAt", "updatedAt")
      SELECT
        date("entryTimestamp") AS telemetry_date,
        'pending',
        MIN(COALESCE("createdAt", CURRENT_TIMESTAMP)),
        MAX(COALESCE("updatedAt", CURRENT_TIMESTAMP))
      FROM "TelemetryEntry"
      WHERE "entryTimestamp" IS NOT NULL
      GROUP BY date("entryTimestamp")
    `)

    await getDb().$executeRawUnsafe(`
      UPDATE "TelemetryEntry"
      SET "telemetryId" = (
        SELECT td."id"
        FROM "TelemetryDaily" td
        WHERE td."telemetryDate" = date("TelemetryEntry"."entryTimestamp")
      )
      WHERE EXISTS (
        SELECT 1
        FROM "TelemetryDaily" td
        WHERE td."telemetryDate" = date("TelemetryEntry"."entryTimestamp")
      )
    `)

    const diagnosisColumns = await getTableColumns('DiagnosisEntry')
    if (diagnosisColumns.has('currentState')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "currentState" = COALESCE(NULLIF("currentState", ''), 'pending')
        WHERE "currentState" IS NULL OR "currentState" = ''
      `)
    }
    if (diagnosisColumns.has('category')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "category" = 'unknown'
        WHERE "category" IS NULL OR trim("category") = ''
      `)
    }
    if (diagnosisColumns.has('sourceCategory')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "sourceCategory" = 'telemetry'
        WHERE "sourceCategory" IS NULL OR trim("sourceCategory") = ''
      `)
    }
    if (diagnosisColumns.has('sourceKind')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "sourceKind" = 'telemetry_entry'
        WHERE "sourceKind" IS NULL OR trim("sourceKind") = ''
      `)
    }
    if (diagnosisColumns.has('logLevel')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "logLevel" = 'infrastructure'
        WHERE "logLevel" IS NULL OR trim("logLevel") = ''
      `)
    }
    if (diagnosisColumns.has('severity')) {
      await getDb().$executeRawUnsafe(`
        UPDATE "DiagnosisEntry"
        SET "severity" = 'unknown'
        WHERE "severity" IS NULL OR trim("severity") = ''
      `)
    }
    await getDb().$executeRawUnsafe(`
      UPDATE "DiagnosisEntry"
      SET "stateTexts" = COALESCE(NULLIF("stateTexts", ''), '{}')
      WHERE "stateTexts" IS NULL OR "stateTexts" = ''
    `)

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisEntrySourceRef" (
        "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        "diagnosisEntryId" INTEGER NOT NULL,
        "sourceTableName" TEXT NOT NULL,
        "sourceFieldName" TEXT NOT NULL,
        "sourceKeyValue" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisEntrySourceRef_diagnosisEntryId_fkey" FOREIGN KEY ("diagnosisEntryId") REFERENCES "DiagnosisEntry" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)

    await getDb().$executeRawUnsafe(`
      INSERT OR IGNORE INTO "DiagnosisEntrySourceRef" (
        "diagnosisEntryId",
        "sourceTableName",
        "sourceFieldName",
        "sourceKeyValue",
        "createdAt",
        "updatedAt"
      )
      SELECT
        de."id",
        'TelemetryEntry',
        'id',
        CAST(COALESCE(de."telemetryEntryId", de."id") AS TEXT),
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM "DiagnosisEntry" de
    `)

    if (telemetryColumns.has('entryId')) {
      await getDb().$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "TelemetryEntry_telemetryId_entryId_key" ON "TelemetryEntry"("telemetryId", "entryId")
      `)
    }
    if (diagnosisColumns.has('currentState')) {
      await getDb().$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "DiagnosisEntry_currentState_idx" ON "DiagnosisEntry"("currentState")
      `)
    }
    if (diagnosisColumns.has('category')) {
      await getDb().$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "DiagnosisEntry_category_idx" ON "DiagnosisEntry"("category")
      `)
    }
    if (diagnosisColumns.has('sourceCategory')) {
      await getDb().$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "DiagnosisEntry_sourceCategory_idx" ON "DiagnosisEntry"("sourceCategory")
      `)
    }
    if (diagnosisColumns.has('logLevel')) {
      await getDb().$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "DiagnosisEntry_logLevel_idx" ON "DiagnosisEntry"("logLevel")
      `)
    }
    if (diagnosisColumns.has('severity')) {
      await getDb().$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS "DiagnosisEntry_severity_idx" ON "DiagnosisEntry"("severity")
      `)
    }
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisEntrySourceRef_diagnosisEntryId_key" ON "DiagnosisEntrySourceRef"("diagnosisEntryId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DiagnosisEntrySourceRef_lookup_idx" ON "DiagnosisEntrySourceRef"("sourceTableName", "sourceFieldName", "sourceKeyValue")
    `)

    await backfillDiagnosisRowsForCoreParity()

    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "IncidentThread" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "state" TEXT NOT NULL,
        "sessionId" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        "archivedAt" DATETIME,
        "deletedAt" DATETIME
      )
    `)
    const incidentThreadColumns = await getTableColumns('IncidentThread')
    if (!incidentThreadColumns.has('sessionId')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "IncidentThread" ADD COLUMN "sessionId" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "IncidentMessage" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "threadId" TEXT NOT NULL,
        "sortOrder" INTEGER NOT NULL,
        "kind" TEXT NOT NULL,
        "text" TEXT,
        "streamText" TEXT,
        "toolCallsJson" TEXT,
        "finalText" TEXT,
        "status" TEXT,
        "errorMsg" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "IncidentMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "IncidentThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "IncidentMessage_threadId_sortOrder_idx" ON "IncidentMessage"("threadId", "sortOrder")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "GlobalVariable" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "key" TEXT NOT NULL,
        "value" TEXT,
        "valueRef" TEXT,
        "description" TEXT,
        "secure" INTEGER NOT NULL DEFAULT 0,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "GlobalVariable_key_key" ON "GlobalVariable"("key")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Runbook" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "idleTimeout" INTEGER,
        "revisionNumber" INTEGER NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        "deletedAt" DATETIME
      )
    `)
    const runbookColumns = await getTableColumns('Runbook')
    if (!runbookColumns.has('revisionNumber')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "Runbook" ADD COLUMN "revisionNumber" INTEGER NOT NULL DEFAULT 1
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!runbookColumns.has('idleTimeout')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "Runbook" ADD COLUMN "idleTimeout" INTEGER
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    await getDb().$executeRawUnsafe(`
      UPDATE "Runbook"
      SET "revisionNumber" = COALESCE("revisionNumber", 1)
      WHERE "revisionNumber" IS NULL OR "revisionNumber" < 1
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RunbookAction" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runbookId" TEXT NOT NULL,
        "sortOrder" INTEGER NOT NULL,
        "type" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "command" TEXT,
        "prompt" TEXT,
        "llmProviderKey" TEXT,
        "llmModel" TEXT,
        "url" TEXT,
        "method" TEXT,
        "headersJson" TEXT,
        "body" TEXT,
        "query" TEXT,
        "sourceId" TEXT,
        "parametersJson" TEXT,
        "logFilterJson" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "RunbookAction_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "Runbook" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    const runbookActionAlterColumns = [
      { name: 'llmProviderKey', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "llmProviderKey" TEXT' },
      { name: 'llmModel', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "llmModel" TEXT' },
      { name: 'headersJson', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "headersJson" TEXT' },
      { name: 'body', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "body" TEXT' },
      { name: 'sourceId', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "sourceId" TEXT' },
      { name: 'parametersJson', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "parametersJson" TEXT' },
      { name: 'logFilterJson', sql: 'ALTER TABLE "RunbookAction" ADD COLUMN "logFilterJson" TEXT' },
    ]
    for (const column of runbookActionAlterColumns) {
      try {
        await getDb().$executeRawUnsafe(column.sql)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "RunbookAction_runbookId_sortOrder_idx" ON "RunbookAction"("runbookId", "sortOrder")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RunbookVersion" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runbookId" TEXT NOT NULL,
        "versionNumber" INTEGER NOT NULL,
        "isLatest" BOOLEAN NOT NULL DEFAULT 1,
        "actionsJson" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "RunbookVersion_runbookId_fkey" FOREIGN KEY ("runbookId") REFERENCES "Runbook" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "RunbookVersion_runbookId_idx" ON "RunbookVersion"("runbookId", "versionNumber" DESC)
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisSession" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runbookId" TEXT NOT NULL,
        "runbookVersionId" TEXT,
        "runbookTitle" TEXT NOT NULL,
        "runbookRevisionNumber" INTEGER,
        "runbookContextJson" TEXT,
        "executionId" TEXT,
        "executionSnapshotJson" TEXT,
        "status" TEXT NOT NULL,
        "startedAt" DATETIME NOT NULL,
        "completedAt" DATETIME,
        "prompt" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    const diagnosisSessionColumns = await getTableColumns('DiagnosisSession')
    if (!diagnosisSessionColumns.has('runbookRevisionNumber')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "DiagnosisSession" ADD COLUMN "runbookRevisionNumber" INTEGER
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!diagnosisSessionColumns.has('runbookContextJson')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "DiagnosisSession" ADD COLUMN "runbookContextJson" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!diagnosisSessionColumns.has('executionId')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "DiagnosisSession" ADD COLUMN "executionId" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!diagnosisSessionColumns.has('executionSnapshotJson')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "DiagnosisSession" ADD COLUMN "executionSnapshotJson" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DiagnosisSession_runbookId_idx" ON "DiagnosisSession"("runbookId", "startedAt" DESC)
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisSession_executionId_key" ON "DiagnosisSession"("executionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisTraceEntry" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "diagnosisSessionId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisTraceEntry_sessionId_fkey" FOREIGN KEY ("diagnosisSessionId") REFERENCES "DiagnosisSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisTraceEntry_session_key" ON "DiagnosisTraceEntry"("diagnosisSessionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisToolRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "diagnosisSessionId" TEXT NOT NULL,
        "sortOrder" INTEGER NOT NULL,
        "toolCallId" TEXT NOT NULL,
        "toolName" TEXT NOT NULL,
        "state" TEXT NOT NULL,
        "output" TEXT,
        "error" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisToolRun_sessionId_fkey" FOREIGN KEY ("diagnosisSessionId") REFERENCES "DiagnosisSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DiagnosisToolRun_session_sortOrder_idx" ON "DiagnosisToolRun"("diagnosisSessionId", "sortOrder")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiagnosisReport" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "diagnosisSessionId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "DiagnosisReport_sessionId_fkey" FOREIGN KEY ("diagnosisSessionId") REFERENCES "DiagnosisSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DiagnosisReport_session_key" ON "DiagnosisReport"("diagnosisSessionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "InvestigationSession" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "runbookId" TEXT NOT NULL,
        "runbookVersionId" TEXT,
        "runbookTitle" TEXT NOT NULL,
        "runbookRevisionNumber" INTEGER,
        "runbookContextJson" TEXT,
        "executionId" TEXT,
        "incidentThreadId" TEXT,
        "executionSnapshotJson" TEXT,
        "status" TEXT NOT NULL,
        "startedAt" DATETIME NOT NULL,
        "completedAt" DATETIME,
        "prompt" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    const investigationSessionColumns = await getTableColumns('InvestigationSession')
    if (!investigationSessionColumns.has('runbookRevisionNumber')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "InvestigationSession" ADD COLUMN "runbookRevisionNumber" INTEGER
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!investigationSessionColumns.has('runbookContextJson')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "InvestigationSession" ADD COLUMN "runbookContextJson" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!investigationSessionColumns.has('executionId')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "InvestigationSession" ADD COLUMN "executionId" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!investigationSessionColumns.has('incidentThreadId')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "InvestigationSession" ADD COLUMN "incidentThreadId" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    if (!investigationSessionColumns.has('executionSnapshotJson')) {
      try {
        await getDb().$executeRawUnsafe(`
          ALTER TABLE "InvestigationSession" ADD COLUMN "executionSnapshotJson" TEXT
        `)
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error
      }
    }
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "InvestigationSession_runbookId_idx" ON "InvestigationSession"("runbookId", "startedAt" DESC)
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "InvestigationSession_incidentThreadId_startedAt_idx" ON "InvestigationSession"("incidentThreadId", "startedAt" DESC)
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "InvestigationSession_executionId_key" ON "InvestigationSession"("executionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "RunbookExecutionControl" (
        "executionId" TEXT NOT NULL PRIMARY KEY,
        "ownerId" TEXT NOT NULL,
        "heartbeatAt" DATETIME NOT NULL,
        "cancelRequestedAt" DATETIME,
        "completedAt" DATETIME,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "RunbookExecutionControl_heartbeatAt_idx" ON "RunbookExecutionControl"("heartbeatAt")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "InvestigationTraceEntry" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "investigationSessionId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "InvestigationTraceEntry_sessionId_fkey" FOREIGN KEY ("investigationSessionId") REFERENCES "InvestigationSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "InvestigationTraceEntry_session_key" ON "InvestigationTraceEntry"("investigationSessionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "InvestigationToolRun" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "investigationSessionId" TEXT NOT NULL,
        "sortOrder" INTEGER NOT NULL,
        "toolCallId" TEXT NOT NULL,
        "toolName" TEXT NOT NULL,
        "state" TEXT NOT NULL,
        "output" TEXT,
        "error" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "InvestigationToolRun_sessionId_fkey" FOREIGN KEY ("investigationSessionId") REFERENCES "InvestigationSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "InvestigationToolRun_session_sortOrder_idx" ON "InvestigationToolRun"("investigationSessionId", "sortOrder")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "InvestigationReport" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "investigationSessionId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "InvestigationReport_sessionId_fkey" FOREIGN KEY ("investigationSessionId") REFERENCES "InvestigationSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "InvestigationReport_session_key" ON "InvestigationReport"("investigationSessionId")
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ActivityEvent" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "entityType" TEXT NOT NULL,
        "entityId" TEXT NOT NULL,
        "eventType" TEXT NOT NULL,
        "payloadJson" TEXT,
        "createdAt" DATETIME NOT NULL,
        "updatedAt" DATETIME NOT NULL
      )
    `)
    await getDb().$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ActivityEvent_entity_lookup_idx" ON "ActivityEvent"("entityType", "entityId", "createdAt" DESC)
    `)
    await getDb().$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "LegacyImportLedger" (
        "key" TEXT NOT NULL PRIMARY KEY,
        "importedAt" DATETIME NOT NULL,
        "payloadJson" TEXT
      )
    `)

    await backfillRunbookActionsFromLegacyVersions()

    if (!appliedVersions.has(1)) {
      await markMigrationApplied(1, 'baseline_core_schema')
    }
    if (!appliedVersions.has(2)) {
      await markMigrationApplied(2, 'telemetry_diagnosis_cve_schema')
    }
    if (!appliedVersions.has(3)) {
      await markMigrationApplied(3, 'job_schedule_registry_and_durability')
    }
    if (!appliedVersions.has(4)) {
      await markMigrationApplied(4, 'worker_core_parity_alignment')
    }
    if (!appliedVersions.has(5)) {
      await markMigrationApplied(5, 'error_source_integration_schema')
    }
    if (!appliedVersions.has(6)) {
      await markMigrationApplied(6, 'error_source_log_level_threshold')
    }
    if (!appliedVersions.has(7)) {
      await markMigrationApplied(7, 'diagnosis_multi_source_generalization')
    }
    if (!appliedVersions.has(8)) {
      await markMigrationApplied(8, 'desktop_phase1_product_state')
    }
    if (!appliedVersions.has(9)) {
      await markMigrationApplied(9, 'runbook_single_live_version_schema')
    }
    if (!appliedVersions.has(10)) {
      await markMigrationApplied(10, 'runbook_external_source_action_type')
    }
    if (!appliedVersions.has(11)) {
      await markMigrationApplied(11, 'runbook_diagnosis_durable_snapshots')
    }
    if (!appliedVersions.has(12)) {
      await markMigrationApplied(12, 'runbook_investigation_slice_rename')
    }
    if (!appliedVersions.has(13)) {
      await markMigrationApplied(13, 'runbook_global_variables')
    }
    if (!appliedVersions.has(14)) {
      await markMigrationApplied(14, 'runbook_idle_timeout')
    }
    if (!appliedVersions.has(15)) {
      await getDb().$executeRawUnsafe(`
        UPDATE "ErrorIssue"
        SET
          "metadata" = CASE
            WHEN "metadata" IS NULL OR trim("metadata") = '' THEN NULL
            WHEN json_valid("metadata") AND json_type("metadata", '$.metadata') = 'object'
              THEN json_extract("metadata", '$.metadata')
            ELSE NULL
          END,
          "additionalMetadata" = NULL
      `)
      await getDb().$executeRawUnsafe(`
        UPDATE "ErrorEvent"
        SET "additionalMetadata" = NULL
        WHERE "additionalMetadata" IS NOT NULL
      `)
      await getDb().$executeRawUnsafe(`
        UPDATE "TelemetryEntry"
        SET
          "entrySource" = (
            SELECT json_object(
              'schema', 'external-source-ref',
              'version', 1,
              'sourceType', COALESCE(es."sourceType", json_extract("TelemetryEntry"."entrySource", '$.sourceType'), "TelemetryEntry"."inputType"),
              'sourceId', ee."sourceId",
              'issueId', ei."id",
              'issueExternalId', ei."externalIssueId",
              'issueTitle', ei."title",
              'issueEnvironment', ei."environment",
              'projectIdentifier', ei."projectIdentifier",
              'eventId', ee."id",
              'eventExternalId', ee."externalEventId",
              'eventMessage', ee."message",
              'eventExceptionValue', ee."exceptionValue",
              'eventEnvironment', ee."environment",
              'serverName', ee."serverName"
            )
            FROM "ErrorEvent" ee
            LEFT JOIN "ErrorIssue" ei ON ei."id" = ee."issueId"
            LEFT JOIN "ErrorSource" es ON es."id" = ee."sourceId"
            WHERE ee."externalEventId" = "TelemetryEntry"."entryId"
              AND ee."sourceId" = json_extract("TelemetryEntry"."entrySource", '$.sourceId')
            LIMIT 1
          ),
          "fullLog" = COALESCE(
            (
              SELECT substr(
                COALESCE(
                  NULLIF(ee."message", ''),
                  NULLIF(ee."exceptionValue", ''),
                  NULLIF(ei."title", ''),
                  upper(COALESCE(es."sourceType", "TelemetryEntry"."inputType")) || ' error event'
                ) ||
                CASE
                  WHEN COALESCE(ei."projectIdentifier", ei."externalIssueId", ee."externalEventId") IS NULL THEN ''
                  ELSE ' [' ||
                    COALESCE(ei."projectIdentifier", ei."externalIssueId", ee."externalEventId") ||
                    CASE
                      WHEN ei."externalIssueId" IS NOT NULL AND ee."externalEventId" IS NOT NULL
                        THEN ' | ' || ee."externalEventId"
                      ELSE ''
                    END ||
                  ']'
                END,
                1,
                1024
              )
              FROM "ErrorEvent" ee
              LEFT JOIN "ErrorIssue" ei ON ei."id" = ee."issueId"
              LEFT JOIN "ErrorSource" es ON es."id" = ee."sourceId"
              WHERE ee."externalEventId" = "TelemetryEntry"."entryId"
                AND ee."sourceId" = json_extract("TelemetryEntry"."entrySource", '$.sourceId')
              LIMIT 1
            ),
            "fullLog"
          )
        WHERE "inputType" IN ('sentry', 'posthog', 'wazuh')
          AND json_valid("entrySource")
          AND json_extract("entrySource", '$.sourceId') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "ErrorEvent" ee
            WHERE ee."externalEventId" = "TelemetryEntry"."entryId"
              AND ee."sourceId" = json_extract("TelemetryEntry"."entrySource", '$.sourceId')
          )
      `)
      await markMigrationApplied(15, 'compact_external_source_payloads')
    }
    if (!appliedVersions.has(16)) {
      await markMigrationApplied(16, 'runbook_execution_control_plane')
    }
    await getDb().$executeRawUnsafe(`PRAGMA user_version = ${String(DATABASE_SCHEMA_VERSION)}`)

    log.info('[database] Schema tables ensured')
  } catch (error) {
    log.error('[database] Failed to ensure schema tables:', error)
    throw error
  }
}

interface DiagnosisBackfillRow {
  [key: string]: unknown
  id: number
  telemetryEntryId: number
  currentState: string | null
  stateHistory: string | null
  stateTexts: string | null
}

interface StateHistoryItem {
  toState?: string
}

function normalizeDiagnosisState(state: unknown): string {
  let value = ''
  if (typeof state === 'string') {
    value = state.trim().toLowerCase()
  }

  const validStates = new Set([
    'pending',
    'llm_assessed',
    'verification_pending',
    'verified',
    'completed',
    'failed',
  ])
  if (validStates.has(value)) {
    return value
  }

  return 'pending'
}

function parseStateHistory(raw: unknown): StateHistoryItem[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(
      (item): item is StateHistoryItem =>
        typeof item === 'object' && item !== null && !Array.isArray(item),
    )
  } catch {
    return []
  }
}

function parseStateTextsObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {}

  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Legacy plain text path handled below.
  }

  return {}
}

function stateText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  return trimmed
}

function firstStateText(
  stateTextObject: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const text = stateText(stateTextObject[key])
    if (text !== undefined) {
      return text
    }
  }

  return undefined
}

function normalizedStructuredStateTexts(
  stateTextObject: Record<string, unknown>,
): Record<string, string> | undefined {
  const diagnose = firstStateText(stateTextObject, ['diagnose', 'assessment'])
  const verify = firstStateText(stateTextObject, [
    'verify',
    'verificationText',
    'verification_text',
    'diagnosisConfirmation',
    'diagnosis_confirmation',
  ])
  const recommend = firstStateText(stateTextObject, [
    'recommend',
    'actualRemediation',
    'actual_remediation',
  ])

  if (diagnose === undefined && verify === undefined && recommend === undefined) {
    return undefined
  }

  const stateTexts: Record<string, string> = {}
  if (diagnose !== undefined) {
    stateTexts.diagnose = diagnose
  }
  if (verify !== undefined) {
    stateTexts.verify = verify
  }
  if (recommend !== undefined) {
    stateTexts.recommend = recommend
  }

  return stateTexts
}

function normalizeLegacyStateText(legacyText: string, currentState: string): Record<string, string> {
  if (currentState === 'completed') return { recommend: legacyText }
  if (currentState === 'verified' || currentState === 'verification_pending') {
    return { verify: legacyText }
  }
  if (currentState === 'llm_assessed') return { diagnose: legacyText }
  return { diagnose: legacyText }
}

function normalizeStateTexts(raw: unknown, currentState: string): Record<string, string> {
  const structuredStateTexts = normalizedStructuredStateTexts(parseStateTextsObject(raw))
  if (structuredStateTexts !== undefined) {
    return structuredStateTexts
  }

  if (typeof raw === 'string' && raw.trim().length > 0) {
    const legacyText = raw.trim()
    if (legacyText.startsWith('{') || legacyText.startsWith('[')) {
      return {}
    }

    return normalizeLegacyStateText(legacyText, currentState)
  }

  return {}
}

async function backfillDiagnosisRowsForCoreParity(): Promise<void> {
  const columns = await getTableColumns('DiagnosisEntry')
  if (!columns.has('stateHistory') || !columns.has('stateTexts')) {
    return
  }

  let currentStateSelect = 'NULL AS "currentState"'
  if (columns.has('currentState')) {
    currentStateSelect = '"currentState"'
  }

  const rows = await getDb().$queryRawUnsafe<DiagnosisBackfillRow>(`
    SELECT
      "id",
      "telemetryEntryId",
      ${currentStateSelect},
      "stateHistory",
      "stateTexts"
    FROM "DiagnosisEntry"
  `)

  for (const row of rows) {
    const history = parseStateHistory(row.stateHistory)
    const lastState = normalizeDiagnosisState(history[history.length - 1]?.toState)
    const currentState = normalizeDiagnosisState(row.currentState ?? lastState)
    const stateTexts = normalizeStateTexts(row.stateTexts, currentState)

    const assignments = [`"stateTexts" = '${escapedSqlString(JSON.stringify(stateTexts))}'`]
    if (columns.has('currentState')) {
      assignments.unshift(`"currentState" = '${escapedSqlString(currentState)}'`)
    }

    await getDb().$executeRawUnsafe(`
      UPDATE "DiagnosisEntry"
      SET ${assignments.join(', ')}
      WHERE "id" = ${String(row.id)}
    `)
  }
}

export function getDatabase(): DbClient {
  if (db === null) {
    throw new Error('Database not initialized. Call initializeDatabase() first.')
  }
  return db
}

export async function resetDatabase(): Promise<void> {
  const client = db ?? await initializeDatabase()
  const seeders = getConfiguredSeeders()
  const tableRows = await client.$queryRawUnsafe<{ name?: string }>(`
    SELECT "name"
    FROM sqlite_master
    WHERE "type" = 'table'
      AND "name" NOT LIKE 'sqlite_%'
      AND "name" != '_MigrationLedger'
    ORDER BY "name" ASC
  `)
  const tableNames = tableRows.flatMap((row: { name?: string }) => {
    if (row.name === undefined) {
      return []
    }

    const name = row.name.trim()
    if (name.length === 0) {
      return []
    }

    return [name]
  })

  await client.$executeRawUnsafe('PRAGMA foreign_keys = OFF')
  try {
    for (const tableName of tableNames) {
      const escapedTableName = tableName.replace(/"/g, '""')
      await client.$executeRawUnsafe(`DELETE FROM "${escapedTableName}"`)
    }
    await client.$executeRawUnsafe('DELETE FROM sqlite_sequence')
  } finally {
    await client.$executeRawUnsafe('PRAGMA foreign_keys = ON')
  }

  await seeders.seedDefaults(client)
  await client.$executeRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)')
  log.warn(`[database] Reset local SQLite data in-place at ${getDatabasePath()}`)
}

export async function closeDatabase(): Promise<void> {
  if (db !== null) {
    await db.$disconnect()
    db = null
    log.info('[database] Disconnected from SQLite')
  }
}
