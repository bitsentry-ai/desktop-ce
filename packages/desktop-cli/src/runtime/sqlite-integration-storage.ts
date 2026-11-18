import { createHash, randomUUID } from 'node:crypto'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import type { DesktopIntegrationStorage } from '@bitsentry-ce/core/features/plugins/desktop-plugin-runtime.node'
import { describeIntegrationConnection, integrationConnectionInputSchema, keepStoredCredentials, validateIntegrationConnection, type IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins/integration-connections'
import type { IntegrationConnectionStorage } from '@bitsentry-ce/core/features/plugins/integration-connection-store'
import { canonical, integrationOperationSchema, type IntegrationOperation, type IntegrationOperationStore } from '@bitsentry-ce/core/features/plugins/integration-operations'
import { integrationResourceSchema, type IntegrationResource } from '@bitsentry-ce/core/features/plugins/integration-resources'
import { customerReportInputSchema, customerReportSchema, type CustomerReport, type CustomerReportInput, type CustomerReportStore } from '@bitsentry-ce/core/features/plugins/customer-reports'
import { customerReportIntakeSchema, type CustomerReportIntake, type CustomerReportIntakeStore } from '@bitsentry-ce/core/features/plugins/customer-report-intake'
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
export class SqliteIntegrationConnections implements IntegrationConnectionStorage {
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {}

  /** The revision is the row's counter as text, so an approval written for an earlier save stops. */
  private async toInput(row: Row): Promise<IntegrationConnectionInput> {
    const config: unknown = JSON.parse(await this.secrets.openPayload(`connection:${String(row.id)}`, String(row.configCiphertext)))
    const auth = row.credentialRef === null ? {} : await this.secrets.get(String(row.credentialRef))
    return integrationConnectionInputSchema.parse({ ...(config as Row), id: row.id, name: row.name, pluginId: row.pluginId, enabled: row.status === 'active', auth, revision: String(row.revision) })
  }

  async list(): Promise<IntegrationConnectionInput[]> {
    const rows = await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE "deletedAt" IS NULL ORDER BY "nameKey"')
    return Promise.all(rows.map(row => this.toInput(row)))
  }

  async save(input: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): Promise<void> {
    const old = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE id=?', input.id))[0]
    // An edit that sends no credential keeps the stored ones, as long as the destination stays the same.
    const existing = old && old.deletedAt === null ? await this.toInput(old) : undefined
    const connection = validateIntegrationConnection(keepStoredCredentials(input, existing, plugin), plugin)
    const target = describeIntegrationConnection(connection, plugin).target
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
        ON CONFLICT("connectionId","resourceType","externalId") DO UPDATE SET "snapshotCiphertext"=excluded."snapshotCiphertext","stateVersion"=excluded."stateVersion","observedAt"=excluded."observedAt","updatedAt"=excluded."updatedAt" WHERE "ExternalResource"."observedAt"<=excluded."observedAt"`, parameters: [id, row.connectionId, row.resourceType, row.externalId, encrypted, row.stateVersion ?? 1, row.observedAt, now(), now()] }, { sql: `INSERT INTO "ResourceLink" (id,"resourceId","subjectType","subjectId",role,"createdAt") VALUES (?,?,'thread',?,'referenced',?) ON CONFLICT("resourceId","subjectType","subjectId") DO UPDATE SET "removedAt"=NULL`, parameters: [randomUUID(), id, threadId, now()] })
    }
    return statements
  }
  async save(resources: IntegrationResource[]): Promise<void> { await this.db.$executeBatch(await this.statements(resources)) }
  async select(threadId: string, connectionId: string, resourceType: string, externalId: string, selected: boolean): Promise<void> {
    const id = resourceId({ connectionId, resourceType, externalId })
    const target = (await this.db.$queryRaw<Row>(`SELECT id FROM "ResourceLink" WHERE "resourceId"=? AND "subjectType"='thread' AND "subjectId"=? AND "removedAt" IS NULL`, id, threadId))[0]
    if (!target) throw new Error('Linked resource not found.')
    // Only the named link changes: a conversation can keep several selected sources for its knowledge tools.
    await this.db.$executeBatch([{ sql: 'UPDATE "ResourceLink" SET selected=? WHERE id=? AND "removedAt" IS NULL', parameters: [selected ? 1 : 0, String(target.id)] }])
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
  async create(operation: IntegrationOperation, intentKey = operation.id): Promise<void> {
    const row = integrationOperationSchema.parse(operation)
    const request = await this.secrets.sealPayload(`operation:${row.id}`, JSON.stringify(row))
    const connection = (await this.db.$queryRaw<Row>('SELECT * FROM "IntegrationConnection" WHERE id=? AND "deletedAt" IS NULL', row.connectionId))[0]
    if (!connection || connection.status !== 'active' || String(connection.revision) !== row.connectionRevision || connection.target !== row.target || connection.pluginId !== row.pluginId) throw new Error('Connection changed; create a new preview.')
    const requestHash = hash({ ...row, createdAt: undefined, updatedAt: undefined, status: undefined })
    await this.db.$executeBatch([{ sql: `INSERT INTO "IntegrationOperation" (id,"connectionId","threadId","idempotencyKey","requestHash","requestCiphertext","pluginId","pluginVersion","actionId",target,"connectionName","connectionRevision",status,"proposedBy","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, parameters: [row.id, row.connectionId, row.threadId, intentKey, requestHash, request, row.pluginId, row.pluginVersion, row.actionId, row.target, row.connectionName, Number(connection.revision), row.status, actor, row.createdAt, row.updatedAt] }])
  }
  async transition(id: string, expected: IntegrationOperation['status'], patch: Patch, expectedUpdatedAt?: string): Promise<boolean> {
    // Execution is exclusively controlled by the fenced lease methods above.
    if (!((expected === 'proposed' && patch.status === 'cancelled') || (expected === 'uncertain' && ['reconciled', 'failed'].includes(patch.status)))) return false
    const rows = await this.db.$queryRaw<Row>(`UPDATE "IntegrationOperation" SET status=?,"updatedAt"=?,"resultCiphertext"=?,"messageCode"=NULL WHERE id=? AND status=? AND (? IS NULL OR "updatedAt"=?) RETURNING id`, patch.status, patch.updatedAt, await this.result(id, patch), id, expected, expectedUpdatedAt ?? null, expectedUpdatedAt ?? null)
    return rows.length === 1
  }
}

/** Customer reports keep their text and source sealed; a retry with the same client request ID returns the first save. */
export class SqliteCustomerReports implements CustomerReportStore {
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {}
  private async decode(row: Row): Promise<CustomerReport> {
    const payload: unknown = JSON.parse(await this.secrets.openPayload(`customer-report:${String(row.id)}`, String(row.payloadCiphertext)))
    return customerReportSchema.parse({ ...(payload as Row), id: row.id, threadId: row.threadId, clientRequestId: row.clientRequestId, channel: row.channel, operationId: row.operationId ?? null, supersededById: row.supersededById ?? null, createdAt: row.createdAt })
  }
  private async find(threadId: string, clientRequestId: string): Promise<CustomerReport | null> {
    const row = (await this.db.$queryRaw<Row>(`${SELECT_REPORT} WHERE r."threadId"=? AND r."clientRequestId"=?`, threadId, clientRequestId))[0]
    return row ? this.decode(row) : null
  }
  async save(value: CustomerReportInput, submittedBy: string): Promise<CustomerReport> {
    const input = customerReportInputSchema.parse(value)
    const existing = await this.find(input.threadId, input.clientRequestId)
    if (existing === null) {
      const id = randomUUID()
      const { sender, receivedAt, timeZone, subject, reportText, intakeId } = input
      const payload = await this.secrets.sealPayload(`customer-report:${id}`, JSON.stringify({ sender, receivedAt, timeZone, subject: subject ?? null, reportText, intakeId: intakeId ?? null, submittedBy }))
      await this.db.$executeBatch([{ sql: `INSERT INTO "CustomerReport" (id,"threadId","clientRequestId",channel,"payloadCiphertext","createdAt") VALUES (?,?,?,?,?,?) ON CONFLICT("threadId","clientRequestId") DO NOTHING`, parameters: [id, input.threadId, input.clientRequestId, input.channel, payload, now()] }])
    }
    const saved = existing ?? await this.find(input.threadId, input.clientRequestId)
    if (saved === null) throw new Error('The customer report could not be saved.')
    // A retry must send the same report; a reused request ID with other content is refused.
    if (saved.channel !== input.channel || saved.sender !== input.sender || saved.receivedAt !== input.receivedAt || saved.timeZone !== input.timeZone || (saved.subject ?? null) !== (input.subject ?? null) || saved.reportText !== input.reportText) {
      throw new Error('This customer report request was already saved with different content.')
    }
    return saved
  }
  async get(threadId: string, id: string): Promise<CustomerReport | null> {
    const row = (await this.db.$queryRaw<Row>(`${SELECT_REPORT} WHERE r.id=? AND r."threadId"=?`, id, threadId))[0]
    return row ? this.decode(row) : null
  }
  async link(threadId: string, id: string, expected: string | null, operationId: string): Promise<boolean> {
    const rows = await this.db.$queryRaw<Row>('UPDATE "CustomerReport" SET "operationId"=? WHERE id=? AND "threadId"=? AND "operationId" IS ? RETURNING id', operationId, id, threadId, expected)
    return rows.length === 1
  }
  /** The first correction of a report is kept; a later one corrects the newer version instead. */
  async supersede(threadId: string, id: string, supersededById: string): Promise<void> {
    await this.db.$executeBatch([{ sql: 'INSERT INTO "CustomerReportCorrection" ("reportId","threadId","supersededById","createdAt") SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM "CustomerReport" WHERE id=? AND "threadId"=?) ON CONFLICT("reportId") DO NOTHING', parameters: [id, threadId, supersededById, now(), supersededById, threadId] }])
  }
}

const SELECT_REPORT = 'SELECT r.*, c."supersededById" FROM "CustomerReport" r LEFT JOIN "CustomerReportCorrection" c ON c."reportId"=r.id'

/** Customer report intakes keep their answers sealed; the status stays readable so a closed intake is never reopened. */
export class SqliteCustomerReportIntakes implements CustomerReportIntakeStore {
  constructor(private readonly db: DbClient, private readonly secrets: LocalPluginCredentialsStore) {}
  private async decode(row: Row): Promise<CustomerReportIntake> {
    const payload: unknown = JSON.parse(await this.secrets.openPayload(`customer-report-intake:${String(row.id)}`, String(row.payloadCiphertext)))
    return customerReportIntakeSchema.parse({ ...(payload as Row), id: row.id, threadId: row.threadId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt })
  }
  async latest(threadId: string): Promise<CustomerReportIntake | null> {
    const row = (await this.db.$queryRaw<Row>('SELECT * FROM "CustomerReportIntake" WHERE "threadId"=? ORDER BY "createdAt" DESC, rowid DESC LIMIT 1', threadId))[0]
    return row ? this.decode(row) : null
  }
  async get(threadId: string, id: string): Promise<CustomerReportIntake | null> {
    const row = (await this.db.$queryRaw<Row>('SELECT * FROM "CustomerReportIntake" WHERE id=? AND "threadId"=?', id, threadId))[0]
    return row ? this.decode(row) : null
  }
  async save(value: CustomerReportIntake): Promise<CustomerReportIntake> {
    const intake = customerReportIntakeSchema.parse(value)
    const { id, threadId, status, createdAt, updatedAt, ...payload } = intake
    const sealed = await this.secrets.sealPayload(`customer-report-intake:${id}`, JSON.stringify(payload))
    await this.db.$executeBatch([{ sql: 'INSERT INTO "CustomerReportIntake" (id,"threadId",status,"payloadCiphertext","createdAt","updatedAt") VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,"payloadCiphertext"=excluded."payloadCiphertext","updatedAt"=excluded."updatedAt" WHERE "CustomerReportIntake"."threadId"=excluded."threadId"', parameters: [id, threadId, status, sealed, createdAt, updatedAt] }])
    const saved = await this.get(threadId, id)
    if (saved === null) throw new Error('The customer report could not be saved.')
    return saved
  }
}

export function createDesktopIntegrationStorage(db: DbClient, secrets: LocalPluginCredentialsStore): DesktopIntegrationStorage {
  const ready = backfillDesktopIntegrationStorage(db, secrets)
  void ready.catch(() => {}) // Surface failures through the requesting integration UI.
  const connections = new SqliteIntegrationConnections(db, secrets)
  const resources = new SqliteIntegrationResources(db, secrets)
  const operations = new SqliteIntegrationOperations(db, secrets)
  const customerReports = new SqliteCustomerReports(db, secrets)
  const customerReportIntakes = new SqliteCustomerReportIntakes(db, secrets)
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
    customerReports: {
      save: async (...args) => { await ready; return customerReports.save(...args) },
      get: async (...args) => { await ready; return customerReports.get(...args) },
      link: async (...args) => { await ready; return customerReports.link(...args) },
      supersede: async (...args) => { await ready; return customerReports.supersede(...args) },
    },
    customerReportIntakes: {
      latest: async threadId => { await ready; return customerReportIntakes.latest(threadId) },
      get: async (...args) => { await ready; return customerReportIntakes.get(...args) },
      save: async intake => { await ready; return customerReportIntakes.save(intake) },
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
