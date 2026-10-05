import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { describeIntegrationConnection, integrationConnectionInputSchema, type IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins/integration-connections'
import { canonical, integrationOperationSchema, type IntegrationOperation } from '@bitsentry-ce/core/features/plugins/integration-operations'
import { integrationResourceSchema, type IntegrationResource } from '@bitsentry-ce/core/features/plugins/integration-resources'
import type { LocalPluginCredentialsStore } from './plugin-credentials-store.js'

type Statement = { sql: string; parameters: (string | number | null)[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
function array(value: unknown): unknown[] {
  if (value === undefined) return []
  const parsed: unknown = JSON.parse(String(value))
  if (!Array.isArray(parsed)) throw new Error('Legacy integration storage is invalid; originals were retained.')
  return parsed
}

type MigrationCipher = Parameters<Parameters<LocalPluginCredentialsStore['migrateIntegrationRecords']>[0]>[1]
async function stageConnections(db: DbClient, cipher: MigrationCipher, connections: IntegrationConnectionInput[], statements: Statement[], timestamp: string): Promise<void> {
    for (const row of connections) {
      const target = describeIntegrationConnection(row).target
      const existing = (await db.$queryRaw<Record<string, unknown>>('SELECT * FROM "IntegrationConnection" WHERE id=?', row.id))[0]
      if (existing) {
        if (existing.target !== target || existing.pluginId !== row.pluginId) throw new Error('Legacy connection identity conflicts with SQLite; originals were retained.')
        continue
      }
      const reference = `bitsentry.connection:${row.id}:legacy`
      cipher.saveAuth(reference, row.auth)
      statements.push({ sql: `INSERT INTO "IntegrationConnection" (id,"pluginId",name,"nameKey",target,"configCiphertext","configVersion","credentialRef",status,"createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,'disabled',?,?)`, parameters: [row.id, row.pluginId, row.name, row.name.toLowerCase(), target, cipher.seal(`connection:${row.id}`, JSON.stringify({ config: row.config, configVersion: row.configVersion, ticketMapping: row.ticketMapping })), row.configVersion ?? 1, reference, timestamp, timestamp] })
    }
}
function stageResources(cipher: MigrationCipher, resources: IntegrationResource[], statements: Statement[], timestamp: string): void {
    const uniqueResources = new Map<string, typeof resources[number]>()
    for (const row of resources) {
      const id = hash([row.connectionId, row.resourceType, row.externalId])
      const previous = uniqueResources.get(id)
      if (!previous || previous.observedAt <= row.observedAt) uniqueResources.set(id, row)
    }
    for (const [id, row] of uniqueResources) {
      const snapshot = { ...row }; delete snapshot.selected; Reflect.deleteProperty(snapshot, "threadId")
      statements.push({ sql: `INSERT INTO "ExternalResource" (id,"connectionId","resourceType","externalId","snapshotCiphertext","stateVersion","observedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT("connectionId","resourceType","externalId") DO NOTHING`, parameters: [id, row.connectionId, row.resourceType, row.externalId, cipher.seal(`resource:${id}`, JSON.stringify(snapshot)), row.stateVersion ?? 1, row.observedAt, timestamp, timestamp] })
    }
    for (const row of resources) {
      const id = hash([row.connectionId, row.resourceType, row.externalId])
      statements.push({ sql: `INSERT INTO "ResourceLink" (id,"resourceId","subjectType","subjectId",role,selected,"createdAt") VALUES (?,?,'thread',?,'referenced',?,?) ON CONFLICT("resourceId","subjectType","subjectId") DO NOTHING`, parameters: [randomUUID(), id, row.threadId, row.selected ? 1 : 0, timestamp] })
    }
}
function importedStatus(status: IntegrationOperation['status']): IntegrationOperation['status'] {
  if (status === 'executing') return 'uncertain'
  return status === 'proposed' ? 'cancelled' : status
}
async function stageOperations(db: DbClient, cipher: MigrationCipher, connections: IntegrationConnectionInput[], operations: IntegrationOperation[], statements: Statement[]): Promise<void> {
    for (const row of operations) {
      const existing = (await db.$queryRaw<Record<string, unknown>>('SELECT "connectionId","requestHash" FROM "IntegrationOperation" WHERE id=?', row.id))[0]
      if (existing && (existing.connectionId !== row.connectionId || existing.requestHash !== hash(row))) throw new Error('Historical operation identity conflicts with SQLite; originals were retained.')
      const connection = connections.find(item => item.id === row.connectionId)!
      if (row.pluginId !== connection.pluginId || row.target !== describeIntegrationConnection(connection).target) throw new Error('Historical operation destination does not match its connection.')
      const status = importedStatus(row.status)
      statements.push({ sql: `INSERT INTO "IntegrationOperation" (id,"connectionId","threadId","idempotencyKey","requestHash","requestCiphertext","pluginId","pluginVersion","actionId",target,"connectionName","connectionRevision",status,"proposedBy","resultCiphertext","messageCode","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,'local-profile',?,?,?,?) ON CONFLICT(id) DO NOTHING`, parameters: [row.id, row.connectionId, row.threadId, `legacy:${row.id}`, hash(row), cipher.seal(`operation:${row.id}`, JSON.stringify(row)), row.pluginId, row.pluginVersion, row.actionId, row.target, row.connectionName, status, cipher.seal(`operation-result:${row.id}`, JSON.stringify({ result: row.result, message: row.message })), row.status === 'proposed' ? 'legacy_preview_requires_new_approval' : row.status === 'executing' ? 'legacy_execution_uncertain' : null, row.createdAt, row.updatedAt] })
    }
}
async function verifyBackfill(db: DbClient, connections: IntegrationConnectionInput[], resources: IntegrationResource[], operations: IntegrationOperation[]): Promise<void> {
    for (const row of connections) if (!(await db.$queryRaw('SELECT id FROM "IntegrationConnection" WHERE id=? AND "pluginId"=?', row.id, row.pluginId)).length) throw new Error('Connection backfill verification failed')
    for (const row of resources) if (!(await db.$queryRaw(`SELECT l.id FROM "ResourceLink" l JOIN "ExternalResource" r ON r.id=l."resourceId" WHERE r."connectionId"=? AND r."resourceType"=? AND r."externalId"=? AND l."subjectType"='thread' AND l."subjectId"=?`, row.connectionId, row.resourceType, row.externalId, row.threadId)).length) throw new Error('Resource backfill verification failed')
    for (const row of operations) if (!(await db.$queryRaw('SELECT id FROM "IntegrationOperation" WHERE id=? AND "connectionId"=?', row.id, row.connectionId)).length) throw new Error('Operation backfill verification failed')
}

/** One transaction imports all three encrypted arrays, under their file lock. */
export async function backfillDesktopIntegrationStorage(db: DbClient, secrets: LocalPluginCredentialsStore): Promise<void> {
  await secrets.migrateIntegrationRecords(async (records, cipher) => {
    if (records['bitsentry.integration-sqlite-cutover.v1'].completed === 'true') return
    const connections = array(records['bitsentry.integration-connections.v1'].connections).map(value => integrationConnectionInputSchema.parse(value))
    const resources = array(records['bitsentry.integration-resources.v1'].resources).map(value => integrationResourceSchema.parse(value))
    const operations = array(records['bitsentry.integration-operations.v1'].operations).map(value => integrationOperationSchema.parse({ pluginVersion: 'legacy-unknown', ...(value as object) }))
    const connectionIds = new Set(connections.map(row => row.id))
    const threadIds = new Set((await db.$queryRaw<{ id: string }>('SELECT id FROM "IncidentThread"')).map(row => row.id))
    if ([...resources, ...operations].some(row => !connectionIds.has(row.connectionId) || !threadIds.has(row.threadId))) throw new Error('Legacy integration history contains a missing connection or thread. Restore its encrypted backup before migrating; no source records were removed.')
    const statements: Statement[] = []
    const timestamp = new Date().toISOString()
    await stageConnections(db, cipher, connections, statements, timestamp)
    stageResources(cipher, resources, statements, timestamp)
    await stageOperations(db, cipher, connections, operations, statements)
    // Persist immutable credential references first. A failed DB batch leaves
    // unused encrypted references, never a row pointing to missing credentials.
    await cipher.flush()
    await db.$executeBatch(statements)
    // Verify every source identity before recording the cutover marker.
    await verifyBackfill(db, connections, resources, operations)
  })
}
