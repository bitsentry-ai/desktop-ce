import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDesktopStateHandlers } from '@bitsentry-ce/core/features/desktop-state/desktop-state.handlers'
import { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { ensureIntegrationStorageSchema } from '../src/runtime/integration-storage-schema.js'
import { DesktopIntegrationOperationStore } from '../src/runtime/integration-operation-store.js'

describe('generic SQLite integration storage', () => {
  it('rolls back a failed schema upgrade and retries without losing legacy data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'integration-upgrade-'))
    const db = new DbClient({ datasources: { db: { url: `file:${path.join(directory, 'profile.db')}` } } })
    try {
      await db.$executeRawUnsafe(`
        CREATE TABLE "Setting" (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO "Setting" VALUES ('retained.setting', 'retained-value');
        CREATE TABLE "ResourceLink" (id TEXT PRIMARY KEY);
      `)
      await expect(ensureIntegrationStorageSchema(db)).rejects.toThrow()
      expect(await db.$queryRaw(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('IntegrationConnection', 'ExternalResource') ORDER BY name`)).toEqual([])
      expect(await db.$queryRaw('SELECT key, value FROM "Setting"')).toEqual([
        { key: 'retained.setting', value: 'retained-value' },
      ])
      await db.$executeRawUnsafe('DROP TABLE "ResourceLink"')
      await ensureIntegrationStorageSchema(db)
      await ensureIntegrationStorageSchema(db)
      expect(await db.$queryRaw(`SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('IntegrationConnection', 'ExternalResource', 'ResourceLink', 'IntegrationOperation', 'IntegrationDelivery')
        ORDER BY name`)).toEqual([
        { name: 'ExternalResource' },
        { name: 'IntegrationConnection' },
        { name: 'IntegrationDelivery' },
        { name: 'IntegrationOperation' },
        { name: 'ResourceLink' },
      ])
      expect(await db.$queryRaw('SELECT key, value FROM "Setting"')).toEqual([
        { key: 'retained.setting', value: 'retained-value' },
      ])
    } finally {
      await db.$disconnect()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('persists approval, fences competing connections, and retains uncertain writes across reopen', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'integration-storage-'))
    const options = { datasources: { db: { url: `file:${path.join(directory, 'profile.db')}` } } }
    const first = new DbClient(options)
    const second = new DbClient(options)
    try {
      await first.$executeRawUnsafe(`
        CREATE TABLE "IncidentThread" (id TEXT PRIMARY KEY, title TEXT, prompt TEXT, state TEXT, "sessionId" TEXT,
          "createdAt" TEXT, "updatedAt" TEXT, "archivedAt" TEXT, "deletedAt" TEXT);
        CREATE TABLE "IncidentMessage" (id TEXT PRIMARY KEY, "threadId" TEXT, "sortOrder" INTEGER, kind TEXT, text TEXT,
          "streamText" TEXT, "toolCallsJson" TEXT, "finalText" TEXT, status TEXT, "errorMsg" TEXT, "createdAt" TEXT, "updatedAt" TEXT);
      `)
      const sync = createDesktopStateHandlers(first)['desktopState:syncIncidents']
      if (sync === undefined) throw new Error('Missing incident sync handler')
      const snapshot = { incidents: [{ id: 'thread', title: 'Thread', prompt: 'Investigate', state: 'completed', createdAt: new Date().toISOString() }],
        incidentMessages: { thread: [{ kind: 'user', text: 'Preserved message' }] } }
      await sync(snapshot)
      await ensureIntegrationStorageSchema(first)
      await ensureIntegrationStorageSchema(first)
      await first.$queryRaw(`INSERT INTO "IntegrationConnection"
        (id,"pluginId",name,"nameKey",target,"configCiphertext","configVersion",status,"createdAt","updatedAt")
        VALUES ('instance','example','Example','example','https://example.test','encrypted-config',1,'active',?,?) RETURNING id`,
      new Date().toISOString(), new Date().toISOString())
      const hash = 'a'.repeat(64)
      await first.$queryRaw(`INSERT INTO "IntegrationOperation"
        (id,"threadId","connectionId","idempotencyKey","requestHash","requestCiphertext","pluginId","pluginVersion","actionId",target,"connectionName","connectionRevision","proposedBy","createdAt","updatedAt")
        VALUES ('intent','thread','instance','intent',?,'encrypted-request','example','1','create','https://example.test','Example',1,'local-user',?,?) RETURNING id`,
      hash, new Date().toISOString(), new Date().toISOString())
      const store = new DesktopIntegrationOperationStore(first, 'local-user')
      const competingStore = new DesktopIntegrationOperationStore(second, 'local-user')
      expect(await store.claim('intent')).toBeUndefined()
      expect(await store.approve('intent', 'b'.repeat(64))).toBeUndefined()
      expect(await store.approve('intent', hash)).toBeDefined()
      const claims = await Promise.all([store.claim('intent'), competingStore.claim('intent')])
      const winner = claims.find((claim) => claim !== undefined)
      expect(claims.filter(Boolean)).toHaveLength(1)
      if (winner?.leaseToken === null || winner?.leaseToken === undefined) throw new Error('Missing claim token')
      expect(await competingStore.finish({ id: 'intent', token: 'stale', status: 'succeeded', resultCiphertext: null, resourceId: null })).toEqual(false)
      await first.$queryRaw('UPDATE "IntegrationOperation" SET "leaseExpiresAt" = 0 WHERE id = ? RETURNING id', 'intent')
      expect(await store.expire()).toEqual(['intent'])
      expect(await store.claim('intent')).toBeUndefined()
      expect(await store.finish({ id: 'intent', token: winner.leaseToken, status: 'succeeded', resultCiphertext: null, resourceId: null })).toEqual(false)
      const reopened = new DbClient(options)
      try {
        const rows = await reopened.$queryRaw('SELECT status, "requestCiphertext" FROM "IntegrationOperation" WHERE id = ?', 'intent')
        expect(rows).toEqual([{ status: 'uncertain', requestCiphertext: 'encrypted-request' }])
      } finally {
        await reopened.$disconnect()
      }
      await sync(snapshot)
      await first.$executeRawUnsafe(`CREATE TRIGGER reject_message BEFORE INSERT ON "IncidentMessage"
        BEGIN SELECT RAISE(ABORT, 'simulated snapshot write failure'); END;`)
      await expect(sync(snapshot)).rejects.toThrow('simulated snapshot write failure')
      expect(await first.$queryRaw('SELECT text FROM "IncidentMessage"')).toEqual([{ text: 'Preserved message' }])
      await first.$executeRawUnsafe('DROP TRIGGER reject_message')
      await sync({ incidents: [], incidentMessages: {} })
      expect((await first.$queryRaw('SELECT "deletedAt" FROM "IncidentThread" WHERE id = ?', 'thread'))[0]?.deletedAt).toBeTruthy()
      expect((await first.$queryRaw('SELECT "threadId" FROM "IntegrationOperation" WHERE id = ?', 'intent'))[0]?.threadId).toBe('thread')
      await expect(async () => {
        await first.$queryRaw('DELETE FROM "IntegrationConnection" WHERE id = ? RETURNING id', 'instance')
      }).rejects.toThrow()
    } finally {
      await first.$disconnect()
      await second.$disconnect()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
