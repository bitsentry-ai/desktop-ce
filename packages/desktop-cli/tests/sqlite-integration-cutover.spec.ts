import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { IntegrationOperationService, type IntegrationOperation } from '@bitsentry-ce/core/features/plugins/integration-operations'
import { describeIntegrationConnection } from '@bitsentry-ce/core/features/plugins/integration-connections'
import type { DesktopPluginDescriptor } from '@bitsentry-ce/core/features/plugins/plugins.types'
import { LocalPluginCredentialsStore } from '../src/runtime/plugin-credentials-store.js'
import { keychainPluginCredentialCipher } from '../src/runtime/keychain-plugin-cipher.js'
import { ensureIntegrationStorageSchema } from '../src/runtime/integration-storage-schema.js'
import { backfillDesktopIntegrationStorage } from '../src/runtime/integration-storage-backfill.js'
import { createDesktopIntegrationStorage } from '../src/runtime/sqlite-integration-storage.js'

const connection = { id: '80000000-0000-4000-8000-000000000001', pluginId: 'outline', name: 'Knowledge', enabled: true, auth: { apiBase: 'https://outline.example/api', accessToken: 'private-token' } }
const plugin: DesktopPluginDescriptor = { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] }
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'sqlite-cutover-'))
  const options = { datasources: { db: { url: `file:${path.join(directory, 'profile.db')}` } } }
  const db = new DbClient(options)
  const second = new DbClient(options)
  await db.$executeRawUnsafe('CREATE TABLE "IncidentThread" (id TEXT PRIMARY KEY, "deletedAt" TEXT); INSERT INTO "IncidentThread" (id) VALUES (\'thread\');')
  await ensureIntegrationStorageSchema(db)
  let key: string | null = null
  const cipher = keychainPluginCredentialCipher(directory, () => { throw new Error('No legacy cipher') }, () => ({ getPassword: () => key, setPassword: value => { key = value } }))
  const secrets = new LocalPluginCredentialsStore(directory, () => cipher)
  return { db, second, secrets, directory, async close() { await db.$disconnect(); await second.$disconnect(); await rm(directory, { recursive: true, force: true }) } }
}

describe('SQLite integration runtime cutover', () => {
  it('deduplicates independent runtime submissions and fences completion after lease loss', async () => {
    const f = await fixture()
    try {
      const first = createDesktopIntegrationStorage(f.db, f.secrets)
      const second = createDesktopIntegrationStorage(f.second, f.secrets)
      await first.connections.save(connection)
      let executions = 0
      const service = (storage: typeof first) => new IntegrationOperationService(storage.operations, async () => {
        const row = (await storage.connections.list())[0]
        return { connection: describeIntegrationConnection(row, plugin), plugin, execute: async () => {
          executions++
          await f.db.$queryRaw('UPDATE "IntegrationOperation" SET "leaseExpiresAt"=0 WHERE status=\'executing\' RETURNING id')
          await second.operations.lease!.expire()
          return { ok: true, status: 200, data: { id: 'remote-created', title: 'Private document title' } }
        } }
      })
      const a = service(first)
      const b = service(second)
      const request = { connectionId: connection.id, actionId: 'create_document', input: { title: 'Private document title' } }
      const proposals = await Promise.all([a.propose('thread', request), b.propose('thread', request)])
      expect(proposals[0].id).toBe(proposals[1].id)
      const raw = (await f.db.$queryRaw<Record<string, unknown>>('SELECT * FROM "IntegrationOperation"'))[0]
      expect(raw.id).not.toBe(raw.idempotencyKey)
      expect(JSON.stringify(raw)).not.toContain('Private document title')
      await Promise.all([a.approve('thread', proposals[0].id, false), b.approve('thread', proposals[0].id, false)])
      expect(executions).toBe(1)
      expect((await a.list('thread'))[0].status).toBe('uncertain')
      expect(await first.operations.transition(proposals[0].id, 'uncertain', { status: 'succeeded', updatedAt: new Date().toISOString() })).toBe(false)
      const reopened = createDesktopIntegrationStorage(f.second, f.secrets)
      expect((await reopened.operations.list('thread'))[0].status).toBe('uncertain')
      const persisted = await readFile(path.join(f.directory, 'auth/plugins.json'), 'utf8')
      expect(persisted).not.toContain('private-token')
      expect((await reopened.connections.list())[0].auth.accessToken).toBe('private-token')
    } finally { await f.close() }
  })

  it('imports encrypted history once, disables connections, keeps selections, and preserves originals', async () => {
    const f = await fixture()
    try {
      const operation: IntegrationOperation = { id: '80000000-0000-4000-8000-000000000002', connectionId: connection.id, threadId: 'thread', connectionName: connection.name, pluginId: 'outline', actionId: 'create_document', target: 'https://outline.example/api', input: { title: 'Historical document' }, publicUpdate: true, requiresCloseRequest: false, status: 'executing', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      const resource = { connectionId: connection.id, connectionName: connection.name, threadId: 'thread', resourceType: 'document', externalId: '42', title: 'Historical document', url: 'https://outline.example/doc/42', state: { revision: 1 }, observedAt: new Date().toISOString(), selected: true }
      await f.secrets.set('bitsentry.integration-connections.v1', { connections: JSON.stringify([connection]) })
      await f.secrets.set('bitsentry.integration-resources.v1', { resources: JSON.stringify([resource]) })
      await f.secrets.set('bitsentry.integration-operations.v1', { operations: JSON.stringify([operation]) })
      await backfillDesktopIntegrationStorage(f.db, f.secrets)
      await backfillDesktopIntegrationStorage(f.db, f.secrets)
      const storage = createDesktopIntegrationStorage(f.second, f.secrets)
      expect(await storage.connections.list()).toHaveLength(1)
      expect((await storage.connections.list())[0].enabled).toBe(false)
      expect((await storage.operations.list('thread'))[0].status).toBe('uncertain')
      expect((await storage.resources.list('thread'))[0]).toMatchObject({ externalId: '42', selected: true })
      expect((await f.secrets.get('bitsentry.integration-operations.v1')).operations).toBe(JSON.stringify([operation]))
      const resourceRows = await f.db.$queryRaw('SELECT * FROM "ExternalResource"')
      expect(resourceRows).toHaveLength(1)
      expect(JSON.stringify(resourceRows)).not.toContain('Historical document')
    } finally { await f.close() }
  })

  it('rejects a stale preview after credentials change without executing', async () => {
    const f = await fixture()
    try {
      const storage = createDesktopIntegrationStorage(f.db, f.secrets)
      await storage.connections.save(connection)
      let executed = false
      const service = new IntegrationOperationService(storage.operations, async () => {
        const row = (await storage.connections.list())[0]
        return { connection: describeIntegrationConnection(row, plugin), plugin, execute: async () => { executed = true; return { ok: true, status: 200, data: {} } } }
      })
      const proposal = await service.propose('thread', { connectionId: connection.id, actionId: 'create_document', input: { title: 'Preview' } })
      await storage.connections.save({ ...connection, auth: { ...connection.auth, accessToken: 'replacement-token' } })
      await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed')
      expect(executed).toBe(false)
      expect((await storage.operations.list('thread'))[0].status).toBe('proposed')
    } finally { await f.close() }
  })
  it('keeps several selected sources, across refreshes and a reopen', async () => {
    const f = await fixture()
    try {
      const storage = createDesktopIntegrationStorage(f.db, f.secrets)
      await storage.connections.save(connection)
      const card = (externalId: string) => ({ connectionId: connection.id, connectionName: connection.name, threadId: 'thread', resourceType: 'document', externalId, title: `Document ${externalId}`, url: `https://outline.example/doc/${externalId}`, state: { revision: 1 }, observedAt: new Date().toISOString() })
      await storage.resources.save([card('1'), card('2'), card('3')])
      await storage.resources.select('thread', connection.id, 'document', '1', true)
      await storage.resources.select('thread', connection.id, 'document', '2', true)
      await storage.resources.select('thread', connection.id, 'document', '1', false)
      await storage.resources.select('thread', connection.id, 'document', '3', true)
      // A refresh of a selected source must not drop it.
      await storage.resources.save([{ ...card('2'), observedAt: new Date(Date.now() + 1000).toISOString() }])
      const selectedIds = async (opened: typeof storage) => (await opened.resources.list('thread')).filter(row => row.selected).map(row => row.externalId).sort()
      expect(await selectedIds(storage)).toEqual(['2', '3'])
      expect(await selectedIds(createDesktopIntegrationStorage(f.second, f.secrets))).toEqual(['2', '3'])
    } finally { await f.close() }
  })

  it('lets a profile created with the one-selection index keep several selected sources', async () => {
    const f = await fixture()
    try {
      await f.db.$executeRawUnsafe('CREATE UNIQUE INDEX "ResourceLink_selected" ON "ResourceLink"("subjectType","subjectId") WHERE "selected" = 1 AND "removedAt" IS NULL')
      await ensureIntegrationStorageSchema(f.db)
      const storage = createDesktopIntegrationStorage(f.db, f.secrets)
      await storage.connections.save(connection)
      const card = (externalId: string) => ({ connectionId: connection.id, connectionName: connection.name, threadId: 'thread', resourceType: 'document', externalId, title: 'Document', url: 'https://outline.example/doc', state: {}, observedAt: new Date().toISOString() })
      await storage.resources.save([card('1'), card('2')])
      await storage.resources.select('thread', connection.id, 'document', '1', true)
      await storage.resources.select('thread', connection.id, 'document', '2', true)
      expect((await storage.resources.list('thread')).filter(row => row.selected)).toHaveLength(2)
    } finally { await f.close() }
  })

  it('keeps the stored credentials when a connection is edited without sending them', async () => {
    const f = await fixture()
    try {
      const storage = createDesktopIntegrationStorage(f.db, f.secrets)
      const timer = { ...plugin, id: 'third-party.time', name: 'Timer', auth: { fields: [{ key: 'apiKey', label: 'Key', type: 'string', required: true, secret: true }] }, actions: [], metadata: { persistence: { configVersion: 1, destinationField: 'serviceUrl', configFields: [{ key: 'serviceUrl', label: 'Service', type: 'string', required: true }, { key: 'project', label: 'Project', type: 'string', required: false }], resources: [], eventChannels: [] } } } as DesktopPluginDescriptor
      const saved = { id: '80000000-0000-4000-8000-000000000009', pluginId: timer.id, name: 'Timer', enabled: true, configVersion: 1, config: { serviceUrl: 'https://timer.example/api', project: 'ops' }, auth: { apiKey: 'private-key' } }
      await storage.connections.save(saved, timer)
      const before = (await storage.connections.list())[0]

      await storage.connections.save({ ...saved, config: { serviceUrl: 'https://timer.example/api', project: 'support' }, auth: {} }, timer)

      const after = (await storage.connections.list())[0]
      expect(after).toMatchObject({ config: { project: 'support' }, auth: { apiKey: 'private-key' } })
      expect(after.revision).not.toBe(before.revision)
    } finally { await f.close() }
  })
})
