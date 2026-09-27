import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'
import { ensureIntegrationStorageSchema } from '../src/runtime/integration-storage-schema.js'
import { DesktopIntegrationOperationStore } from '../src/runtime/integration-operation-store.js'

describe('generic SQLite integration storage', () => {
  it('persists approval, fences competing connections, and retains uncertain writes across reopen', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'integration-storage-'))
    const options = { datasources: { db: { url: `file:${path.join(directory, 'profile.db')}` } } }
    const first = new DbClient(options)
    const second = new DbClient(options)
    try {
      await first.$executeRawUnsafe('CREATE TABLE "IncidentThread" (id TEXT PRIMARY KEY, "deletedAt" TEXT)')
      await ensureIntegrationStorageSchema(first)
      await ensureIntegrationStorageSchema(first)
      await first.$queryRaw(`INSERT INTO "IntegrationConnection"
        (id,"pluginId",name,"nameKey",target,"configCiphertext","configVersion",status,"createdAt","updatedAt")
        VALUES ('instance','example','Example','example','https://example.test','encrypted-config',1,'active',?,?) RETURNING id`,
      new Date().toISOString(), new Date().toISOString())
      const hash = 'a'.repeat(64)
      await first.$queryRaw(`INSERT INTO "IntegrationOperation"
        (id,"connectionId","idempotencyKey","requestHash","requestCiphertext","pluginId","pluginVersion","actionId",target,"connectionName","connectionRevision","proposedBy","createdAt","updatedAt")
        VALUES ('intent','instance','intent',?,'encrypted-request','example','1','create','https://example.test','Example',1,'local-user',?,?) RETURNING id`,
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
      expect(await competingStore.finish({ id: 'intent', token: 'stale', status: 'succeeded', resultCiphertext: null, resourceId: null })).toBe(false)
      await first.$queryRaw('UPDATE "IntegrationOperation" SET "leaseExpiresAt" = 0 WHERE id = ? RETURNING id', 'intent')
      expect(await store.expire()).toEqual(['intent'])
      expect(await store.claim('intent')).toBeUndefined()
      expect(await store.finish({ id: 'intent', token: winner.leaseToken, status: 'succeeded', resultCiphertext: null, resourceId: null })).toBe(false)
      const reopened = new DbClient(options)
      try {
        const rows = await reopened.$queryRaw('SELECT status, "requestCiphertext" FROM "IntegrationOperation" WHERE id = ?', 'intent')
        expect(rows).toEqual([{ status: 'uncertain', requestCiphertext: 'encrypted-request' }])
      } finally {
        await reopened.$disconnect()
      }
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
