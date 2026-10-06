import { randomUUID } from 'node:crypto'
import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'

type OperationRow = Record<string, unknown> & {
  id: string
  status: string
  leaseToken: string | null
  requestCiphertext: string
}

/** The local actor is supplied by the host, never by model/tool arguments. */
export class DesktopIntegrationOperationStore {
  constructor(private readonly db: DbClient, private readonly actor: string) {
    if (!actor.trim()) throw new Error('A host actor is required')
  }

  private readonly eligibleConnection = `EXISTS (
    SELECT 1 FROM "IntegrationConnection" c
    WHERE c."id" = "IntegrationOperation"."connectionId" AND c."status" = 'active' AND c."deletedAt" IS NULL
      AND c."revision" = "IntegrationOperation"."connectionRevision"
      AND c."target" = "IntegrationOperation"."target" AND c."pluginId" = "IntegrationOperation"."pluginId"
  ) AND ("threadId" IS NULL OR EXISTS (
    SELECT 1 FROM "IncidentThread" t WHERE t."id" = "IntegrationOperation"."threadId" AND t."deletedAt" IS NULL
  ))`

  async approve(id: string, requestHash: string): Promise<OperationRow | undefined> {
    const rows = await this.db.$queryRaw<OperationRow>(`
      UPDATE "IntegrationOperation" SET "approvedBy" = ?, "approvedAt" = ?, "approvalRequestHash" = ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'proposed' AND "proposedBy" = ? AND "requestHash" = ?
        AND ${this.eligibleConnection} RETURNING *`,
    this.actor, new Date().toISOString(), requestHash, new Date().toISOString(), id, this.actor, requestHash)
    return rows[0]
  }

  async claim(id: string, leaseSeconds = 60): Promise<OperationRow | undefined> {
    this.validateLease(leaseSeconds)
    const rows = await this.db.$queryRaw<OperationRow>(`
      UPDATE "IntegrationOperation" SET "status" = 'executing', "leaseToken" = ?,
        "leaseExpiresAt" = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, "attempt" = "attempt" + 1, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'proposed' AND "proposedBy" = ? AND "approvedBy" = ?
        AND "approvedAt" IS NOT NULL AND "approvalRequestHash" = "requestHash"
        AND ${this.eligibleConnection} RETURNING *`,
    randomUUID(), leaseSeconds * 1000, new Date().toISOString(), id, this.actor, this.actor)
    return rows[0]
  }

  async heartbeat(id: string, token: string, leaseSeconds = 60): Promise<boolean> {
    this.validateLease(leaseSeconds)
    const rows = await this.db.$queryRaw(`
      UPDATE "IntegrationOperation" SET "leaseExpiresAt" = CAST(unixepoch('subsec') * 1000 AS INTEGER) + ?, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'executing' AND "leaseToken" = ?
        AND "leaseExpiresAt" > CAST(unixepoch('subsec') * 1000 AS INTEGER) RETURNING "id"`,
    leaseSeconds * 1000, new Date().toISOString(), id, token)
    return rows.length === 1
  }

  async finish(input: {
    id: string
    token: string
    status: 'succeeded' | 'failed' | 'uncertain'
    resultCiphertext: string | null
    resourceId: string | null
  }): Promise<boolean> {
    const rows = await this.db.$queryRaw(`
      UPDATE "IntegrationOperation" SET "status" = ?, "resultCiphertext" = ?, "resultResourceId" = ?,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = ?
      WHERE "id" = ? AND "status" = 'executing' AND "leaseToken" = ?
        AND "leaseExpiresAt" > CAST(unixepoch('subsec') * 1000 AS INTEGER) RETURNING "id"`,
    input.status, input.resultCiphertext, input.resourceId, new Date().toISOString(), input.id, input.token)
    return rows.length === 1
  }

  async expire(): Promise<string[]> {
    const rows = await this.db.$queryRaw<{ id: string }>(`
      UPDATE "IntegrationOperation" SET "status" = 'uncertain', "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "messageCode" = 'lease_expired', "updatedAt" = ?
      WHERE "status" = 'executing' AND "leaseExpiresAt" <= CAST(unixepoch('subsec') * 1000 AS INTEGER) RETURNING "id"`,
    new Date().toISOString())
    return rows.map((row) => row.id)
  }

  private validateLease(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Invalid operation lease')
  }
}
