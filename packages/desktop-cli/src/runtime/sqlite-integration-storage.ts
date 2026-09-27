import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import type { DesktopIntegrationStorage } from '@bitsentry-ce/core/features/plugins/desktop-plugin-runtime.node'
import { describeIntegrationConnection, integrationConnectionInputSchema, validateIntegrationConnection, type IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins/integration-connections'
import { canonical, integrationOperationSchema, type IntegrationOperation, type IntegrationOperationStore } from '@bitsentry-ce/core/features/plugins/integration-operations'
import { integrationResourceSchema, type IntegrationResource } from '@bitsentry-ce/core/features/plugins/integration-resources'
import type { DesktopPluginDescriptor } from '@bitsentry-ce/core/features/plugins/plugins.types'
import { LocalPluginCredentialsStore } from './plugin-credentials-store.js'
import { backfillDesktopIntegrationStorage } from './integration-storage-backfill.js'
import { DesktopIntegrationOperationStore } from './integration-operation-store.js'

type Row = Record<string, unknown>
type Statement = { sql: string; parameters: (string | number | null)[] }
const now = () => new Date().toISOString()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const resourceId = (row: Pick<IntegrationResource, 'connectionId' | 'resourceType' | 'externalId'>) => hash([row.connectionId, row.resourceType, row.externalId])
const actor = 'local-profile'

/** Credentials remain in the OS-keychain-backed store; SQLite carries references only. */
export class SqliteIntegrationConnections {
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {}

  async list(): Promise<(IntegrationConnectionInput & { revision: number })[]> {
    const rows = await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE "deletedAt" IS NULL ORDER BY "nameKey"')
    return Promise.all(rows.map(async row => {
      const config: unknown = JSON.parse(await this.secrets.openPayload(`connection:${String(row.id)}`, String(row.configCiphertext)))
      const auth = row.credentialRef === null ? {} : await this.secrets.get(String(row.credentialRef))
      return { ...integrationConnectionInputSchema.parse({ ...(config as Row), id: row.id, name: row.name, pluginId: row.pluginId, target: row.target, enabled: row.status === 'active', auth }), revision: Number(row.revision) }
    }))
  }

  async save(input: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): Promise<void> {
    const connection = validateIntegrationConnection(input, plugin)
    const target = describeIntegrationConnection(connection, plugin).target
    const old = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE id=?', connection.id))[0]
    if (old && (old.deletedAt !== null || old.pluginId !== connection.pluginId || old.target !== target)) throw new Error('Create a new connection to change its identity.')
    const reference = `bitsentry.connection:${connection.id}:${randomUUID()}`
    // Immutable credential generations prevent a concurrent save from changing
    // credentials without also changing the row revision used by approval.
    await this.secrets.set(reference, connection.auth)
    const config = await this.secrets.sealPayload(`connection:${connection.id}`, JSON.stringify({ config: connection.config, configVersion: connection.configVersion, ticketMapping: connection.ticketMapping }))
    await this.db.$executeBatch([{ sql: `INSERT INTO "IntegrationConnection" (id,"pluginId",name,"nameKey",target,"configCiphertext","configVersion","credentialRef",status,"createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,"nameKey"=excluded."nameKey","configCiphertext"=excluded."configCiphertext","configVersion"=excluded."configVersion","credentialRef"=excluded."credentialRef",status=excluded.status,"updatedAt"=excluded."updatedAt"
      WHERE "IntegrationConnection"."deletedAt" IS NULL AND "IntegrationConnection"."pluginId"=excluded."pluginId" AND "IntegrationConnection".target=excluded.target`, parameters: [connection.id, connection.pluginId, connection.name, connection.name.toLowerCase(), target, config, connection.configVersion ?? 1, reference, connection.enabled ? 'active' : 'disabled', now(), now()] }])
    const saved = (await this.db.$queryRaw<Row>('SELECT "credentialRef",target,"pluginId" FROM "IntegrationConnection" WHERE id=? AND "deletedAt" IS NULL', connection.id))[0]
    if (!saved || saved.target !== target || saved.pluginId !== connection.pluginId) throw new Error('Connection was removed or its identity changed during save.')
  }

  async remove(id: string): Promise<void> {
    await this.db.$executeBatch([{ sql: 'UPDATE "IntegrationConnection" SET status=\'disabled\',"deletedAt"=?,"updatedAt"=? WHERE id=? AND "deletedAt" IS NULL', parameters: [now(), now(), id] }])
  }
}

export class SqliteIntegrationResources {
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {}
  async list(threadId: string): Promise<IntegrationResource[]> {
    const rows = await this.db.$queryRaw<Row>(`SELECT r.*,l.selected FROM "ExternalResource" r JOIN "ResourceLink" l ON l."resourceId"=r.id WHERE l."subjectType"='thread' AND l."subjectId"=? AND l."removedAt" IS NULL ORDER BY r."observedAt" DESC`, threadId)
    return Promise.all(rows.map(async row => integrationResourceSchema.parse({ ...JSON.parse(await this.secrets.openPayload(`resource:${String(row.id)}`, String(row.snapshotCiphertext))), threadId, selected: row.selected === 1 })))
  }

  async statements(resources: IntegrationResource[]): Promise<Statement[]> {
    const statements: Statement[] = []
    for (const input of resources) {
      const row = integrationResourceSchema.parse(input)
      const id = resourceId(row)
      const threadId = row.threadId
      const snapshot = { ...row }; delete snapshot.selected; Reflect.deleteProperty(snapshot, "threadId")
      const encrypted = await this.secrets.sealPayload(`resource:${id}`, JSON.stringify(snapshot))
      statements.push({ sql: `INSERT INTO "ExternalResource" (id,"connectionId","resourceType","externalId","snapshotCiphertext","stateVersion","observedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT("connectionId","resourceType","externalId") DO UPDATE SET "snapshotCiphertext"=excluded."snapshotCiphertext","stateVersion"=excluded."stateVersion","observedAt"=excluded."observedAt","updatedAt"=excluded."updatedAt" WHERE "ExternalResource"."observedAt"<=excluded."observedAt"`, parameters: [id, row.connectionId, row.resourceType, row.externalId, encrypted, row.stateVersion ?? 1, row.observedAt, now(), now()] })
      statements.push({ sql: `INSERT INTO "ResourceLink" (id,"resourceId","subjectType","subjectId",role,"createdAt") VALUES (?,?,'thread',?,'referenced',?) ON CONFLICT("resourceId","subjectType","subjectId") DO UPDATE SET "removedAt"=NULL`, parameters: [randomUUID(), id, threadId, now()] })
    }
    return statements
  }
  async save(resources: IntegrationResource[]): Promise<void> { await this.db.$executeBatch(await this.statements(resources)) }
  async select(threadId: string, connectionId: string, resourceType: string, externalId: string, selected: boolean): Promise<void> {
    const id = resourceId({ connectionId, resourceType, externalId })
    const target = (await this.db.$queryRaw<Row>(`SELECT id FROM "ResourceLink" WHERE "resourceId"=? AND "subjectType"='thread' AND "subjectId"=? AND "removedAt" IS NULL`, id, threadId))[0]
    if (!target) throw new Error('Linked resource not found.')
    const statements: Statement[] = []
    if (selected) statements.push({ sql: `UPDATE "ResourceLink" SET selected=0 WHERE "subjectType"='thread' AND "subjectId"=?`, parameters: [threadId] })
    statements.push({ sql: 'UPDATE "ResourceLink" SET selected=? WHERE id=? AND "removedAt" IS NULL', parameters: [selected ? 1 : 0, String(target.id)] })
    await this.db.$executeBatch(statements)
  }
}

type Patch = Pick<IntegrationOperation, 'status' | 'updatedAt'> & Partial<Pick<IntegrationOperation, 'result' | 'message'>>
export class SqliteIntegrationOperations implements IntegrationOperationStore {
  private readonly claims: DesktopIntegrationOperationStore
  readonly lease: NonNullable<IntegrationOperationStore['lease']>
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {
    this.claims = new DesktopIntegrationOperationStore(db, actor)
    this.lease = {
      approveAndClaim: async id => {
        const row = (await db.$queryRaw<Row>('SELECT "requestHash" FROM "IntegrationOperation" WHERE id=?', id))[0]
        if (!row || !await this.claims.approve(id, String(row.requestHash))) return null
        return (await this.claims.claim(id, 120))?.leaseToken ?? null
      },
      heartbeat: (id, token) => this.claims.heartbeat(id, token, 120),
      finish: async (id, token, patch) => {
        if (!['succeeded', 'failed', 'uncertain'].includes(patch.status)) throw new Error('Invalid completion status')
        return this.claims.finish({ id, token, status: patch.status as 'succeeded' | 'failed' | 'uncertain', resultCiphertext: await this.result(id, patch), resourceId: null })
      },
      expire: () => this.claims.expire(),
    }
  }
  private result(id: string, patch: Patch): Promise<string> { return this.secrets.sealPayload(`operation-result:${id}`, JSON.stringify({ result: patch.result, message: patch.message })) }
  private async decode(row: Row): Promise<IntegrationOperation> {
    const request: unknown = JSON.parse(await this.secrets.openPayload(`operation:${String(row.id)}`, String(row.requestCiphertext)))
    const result: unknown = row.resultCiphertext === null ? {} : JSON.parse(await this.secrets.openPayload(`operation-result:${String(row.id)}`, String(row.resultCiphertext)))
    return integrationOperationSchema.parse({ ...(request as Row), ...(result as Row), id: row.id, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, ...(row.messageCode ? { message: row.messageCode } : {}) })
  }
  async list(threadId: string): Promise<IntegrationOperation[]> { return Promise.all((await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationOperation" WHERE "threadId"=? ORDER BY "createdAt"', threadId)).map(row => this.decode(row))) }
  async get(id: string): Promise<IntegrationOperation | null> { const row = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationOperation" WHERE id=?', id))[0]; return row ? this.decode(row) : null }
  async findByIntent(connectionId: string, intentKey: string): Promise<IntegrationOperation | null> { const row = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationOperation" WHERE "connectionId"=? AND "idempotencyKey"=?', connectionId, intentKey))[0]; return row ? this.decode(row) : null }
  async create(operation: IntegrationOperation, pluginVersion = 'legacy-unknown', intentKey = operation.id, connectionRevision?: number): Promise<void> {
    const row = integrationOperationSchema.parse(operation)
    const request = await this.secrets.sealPayload(`operation:${row.id}`, JSON.stringify(row))
    const connection = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE id=? AND "deletedAt" IS NULL', row.connectionId))[0]
    if (!connection || connection.status !== 'active' || connection.revision !== connectionRevision || connection.target !== row.target || connection.pluginId !== row.pluginId) throw new Error('Connection changed; create a new preview.')
    const requestHash = hash({ ...row, createdAt: undefined, updatedAt: undefined, status: undefined, pluginVersion, revision: connection.revision })
    await this.db.$executeBatch([{ sql: `INSERT INTO "IntegrationOperation" (id,"connectionId","threadId","idempotencyKey","requestHash","requestCiphertext","pluginId","pluginVersion","actionId",target,"connectionName","connectionRevision",status,"proposedBy","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, parameters: [row.id, row.connectionId, row.threadId, intentKey, requestHash, request, row.pluginId, pluginVersion, row.actionId, row.target, row.connectionName, Number(connection.revision), row.status, actor, row.createdAt, row.updatedAt] }])
  }
  async transition(id: string, expected: IntegrationOperation['status'], patch: Patch, expectedUpdatedAt?: string): Promise<boolean> {
    // Execution is exclusively controlled by the fenced lease methods above.
    if (!((expected === 'proposed' && patch.status === 'cancelled') || (expected === 'uncertain' && ['reconciled', 'failed'].includes(patch.status)))) return false
    const rows = await this.db.$queryRaw<Row>(`UPDATE "IntegrationOperation" SET status=?,"updatedAt"=?,"resultCiphertext"=?,"messageCode"=NULL WHERE id=? AND status=? AND (? IS NULL OR "updatedAt"=?) RETURNING id`, patch.status, patch.updatedAt, await this.result(id, patch), id, expected, expectedUpdatedAt ?? null, expectedUpdatedAt ?? null)
    return rows.length === 1
  }
}

export function createDesktopIntegrationStorage(db: DbClient, secrets: LocalPluginCredentialsStore): DesktopIntegrationStorage {
  const ready = backfillDesktopIntegrationStorage(db, secrets)
  void ready.catch(() => {}) // Surface failures through the requesting integration UI.
  const connections = new SqliteIntegrationConnections(db, secrets)
  const resources = new SqliteIntegrationResources(db, secrets)
  const operations = new SqliteIntegrationOperations(db, secrets)
  return {
    connections: {
      list: async () => { await ready; return connections.list() },
      save: async (input, plugin) => { await ready; return connections.save(input, plugin) },
      remove: async id => { await ready; return connections.remove(id) },
    },
    resources: {
      list: async threadId => { await ready; return resources.list(threadId) },
      save: async rows => { await ready; return resources.save(rows) },
      select: async (...args) => { await ready; return resources.select(...args) },
    },
    operations: {
      list: async threadId => { await ready; return operations.list(threadId) },
      get: async id => { await ready; return operations.get(id) },
      findByIntent: async (...args) => { await ready; return operations.findByIntent(...args) },
      create: async (...args) => { await ready; return operations.create(...args) },
      transition: async (...args) => { await ready; return operations.transition(...args) },
      lease: {
        approveAndClaim: async id => { await ready; return operations.lease.approveAndClaim(id) },
        heartbeat: async (...args) => { await ready; return operations.lease.heartbeat(...args) },
        finish: async (...args) => { await ready; return operations.lease.finish(...args) },
        expire: async () => { await ready; return operations.lease.expire() },
      },
    },
  }
}
