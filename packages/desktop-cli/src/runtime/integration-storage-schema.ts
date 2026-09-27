import type { DbClient } from '@bitsentry-ce/core/features/desktop/desktop-database-client'

/** Fixed host-owned tables. Adding a plugin never changes this schema. */
export const integrationStorageSchema = `
CREATE TABLE IF NOT EXISTS "IntegrationConnection" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "pluginId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameKey" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "configCiphertext" TEXT NOT NULL,
  "configVersion" INTEGER NOT NULL CHECK ("configVersion" > 0),
  "credentialRef" TEXT,
  "status" TEXT NOT NULL DEFAULT 'disabled' CHECK ("status" IN ('active','disabled')),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "deletedAt" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  CHECK (length(trim("pluginId")) > 0 AND length(trim("target")) > 0 AND length(trim("name")) > 0 AND length(trim("nameKey")) > 0),
  CHECK ("deletedAt" IS NULL OR "status" = 'disabled')
);
CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationConnection_live_name" ON "IntegrationConnection"("nameKey") WHERE "deletedAt" IS NULL;
CREATE TRIGGER IF NOT EXISTS "IntegrationConnection_identity_guard" BEFORE UPDATE ON "IntegrationConnection"
WHEN NEW."pluginId" IS NOT OLD."pluginId" OR NEW."target" IS NOT OLD."target"
BEGIN SELECT RAISE(ABORT, 'Connection identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS "IntegrationConnection_revision_monotonic" BEFORE UPDATE ON "IntegrationConnection"
WHEN NEW."revision" < OLD."revision"
BEGIN SELECT RAISE(ABORT, 'Connection revision cannot decrease'); END;
CREATE TRIGGER IF NOT EXISTS "IntegrationConnection_revision_guard" AFTER UPDATE ON "IntegrationConnection"
WHEN NEW."configCiphertext" IS NOT OLD."configCiphertext" OR NEW."configVersion" IS NOT OLD."configVersion"
  OR NEW."credentialRef" IS NOT OLD."credentialRef" OR NEW."status" IS NOT OLD."status"
  OR NEW."deletedAt" IS NOT OLD."deletedAt" OR NEW."name" IS NOT OLD."name"
BEGIN UPDATE "IntegrationConnection" SET "revision" = OLD."revision" + 1 WHERE "id" = NEW."id"; END;

CREATE TABLE IF NOT EXISTS "ExternalResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT,
  "resourceType" TEXT NOT NULL CHECK (length(trim("resourceType")) > 0),
  "externalId" TEXT NOT NULL CHECK (length(trim("externalId")) > 0),
  "snapshotCiphertext" TEXT NOT NULL,
  "stateVersion" INTEGER NOT NULL CHECK ("stateVersion" > 0),
  "normalizedStatus" TEXT NOT NULL DEFAULT 'unknown' CHECK ("normalizedStatus" IN ('open','in_progress','resolved','closed','cancelled','unknown')),
  "observedAt" TEXT NOT NULL,
  "remoteUpdatedAt" TEXT,
  "lastSyncedAt" TEXT,
  "lastSyncErrorCode" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("connectionId","resourceType","externalId"),
  UNIQUE ("id","connectionId")
);
CREATE TABLE IF NOT EXISTS "ResourceLink" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "resourceId" TEXT NOT NULL REFERENCES "ExternalResource"("id") ON DELETE RESTRICT,
  "subjectType" TEXT NOT NULL CHECK ("subjectType" IN ('thread','diagnosis','error_issue')),
  "subjectId" TEXT NOT NULL,
  "role" TEXT NOT NULL CHECK ("role" IN ('created','referenced','tracked')),
  "selected" INTEGER NOT NULL DEFAULT 0 CHECK ("selected" IN (0,1)),
  "removedAt" TEXT,
  "createdAt" TEXT NOT NULL,
  CHECK ("removedAt" IS NULL OR "selected" = 0),
  UNIQUE ("resourceId","subjectType","subjectId")
);
CREATE INDEX IF NOT EXISTS "ResourceLink_subject" ON "ResourceLink"("subjectType","subjectId","removedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "ResourceLink_selected" ON "ResourceLink"("subjectType","subjectId") WHERE "selected" = 1 AND "removedAt" IS NULL;

CREATE TABLE IF NOT EXISTS "IntegrationOperation" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT,
  "threadId" TEXT REFERENCES "IncidentThread"("id") ON DELETE RESTRICT,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL CHECK (length("requestHash") = 64),
  "requestCiphertext" TEXT NOT NULL,
  "pluginId" TEXT NOT NULL,
  "pluginVersion" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "connectionName" TEXT NOT NULL,
  "connectionRevision" INTEGER NOT NULL CHECK ("connectionRevision" > 0),
  "status" TEXT NOT NULL DEFAULT 'proposed' CHECK ("status" IN ('proposed','executing','succeeded','failed','uncertain','cancelled','reconciled')),
  "proposedBy" TEXT NOT NULL,
  "approvedBy" TEXT,
  "approvedAt" TEXT,
  "approvalRequestHash" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" INTEGER,
  "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  "resultCiphertext" TEXT,
  "resultResourceId" TEXT,
  "messageCode" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("connectionId","idempotencyKey"),
  UNIQUE ("id","connectionId"),
  FOREIGN KEY ("resultResourceId","connectionId") REFERENCES "ExternalResource"("id","connectionId") ON DELETE RESTRICT,
  CHECK (("approvedBy" IS NULL AND "approvedAt" IS NULL AND "approvalRequestHash" IS NULL) OR
    ("approvedBy" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvalRequestHash" IS NOT NULL AND "approvalRequestHash" = "requestHash")),
  CHECK ("status" <> 'executing' OR ("approvedBy" IS NOT NULL AND "leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "attempt" > 0)),
  CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
);
CREATE INDEX IF NOT EXISTS "IntegrationOperation_thread" ON "IntegrationOperation"("threadId","createdAt");
CREATE INDEX IF NOT EXISTS "IntegrationOperation_lease" ON "IntegrationOperation"("status","leaseExpiresAt");
CREATE TRIGGER IF NOT EXISTS "IntegrationOperation_request_guard" BEFORE UPDATE ON "IntegrationOperation"
WHEN NEW."connectionId" IS NOT OLD."connectionId" OR NEW."threadId" IS NOT OLD."threadId"
  OR NEW."idempotencyKey" IS NOT OLD."idempotencyKey" OR NEW."requestHash" IS NOT OLD."requestHash"
  OR NEW."requestCiphertext" IS NOT OLD."requestCiphertext" OR NEW."pluginId" IS NOT OLD."pluginId"
  OR NEW."pluginVersion" IS NOT OLD."pluginVersion" OR NEW."actionId" IS NOT OLD."actionId"
  OR NEW."target" IS NOT OLD."target" OR NEW."connectionName" IS NOT OLD."connectionName"
  OR NEW."connectionRevision" IS NOT OLD."connectionRevision" OR NEW."proposedBy" IS NOT OLD."proposedBy"
BEGIN SELECT RAISE(ABORT, 'Operation request is immutable'); END;
CREATE TRIGGER IF NOT EXISTS "IntegrationOperation_replay_guard" BEFORE UPDATE ON "IntegrationOperation"
WHEN (NEW."status" = 'proposed' AND OLD."status" <> 'proposed') OR
  (NEW."status" = 'executing' AND OLD."status" NOT IN ('proposed','executing'))
BEGIN SELECT RAISE(ABORT, 'Operation requires reconciliation; replay is forbidden'); END;
CREATE TRIGGER IF NOT EXISTS "IntegrationOperation_approval_guard" BEFORE UPDATE ON "IntegrationOperation"
WHEN OLD."status" <> 'proposed' AND (NEW."approvedBy" IS NOT OLD."approvedBy" OR
  NEW."approvedAt" IS NOT OLD."approvedAt" OR NEW."approvalRequestHash" IS NOT OLD."approvalRequestHash")
BEGIN SELECT RAISE(ABORT, 'Executed operation approval is immutable'); END;

CREATE TABLE IF NOT EXISTS "IntegrationDelivery" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "connectionId" TEXT NOT NULL REFERENCES "IntegrationConnection"("id") ON DELETE RESTRICT,
  "direction" TEXT NOT NULL CHECK ("direction" IN ('inbound','outbound')),
  "channel" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL CHECK (length("payloadHash") = 64),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','executing','succeeded','failed','uncertain','cancelled')),
  "attempt" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt" >= 0),
  "nextAttemptAt" INTEGER,
  "leaseToken" TEXT,
  "leaseExpiresAt" INTEGER,
  "resourceId" TEXT,
  "operationId" TEXT,
  "summaryCiphertext" TEXT NOT NULL,
  "resultCiphertext" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("connectionId","direction","channel","eventId"),
  FOREIGN KEY ("resourceId","connectionId") REFERENCES "ExternalResource"("id","connectionId") ON DELETE RESTRICT,
  FOREIGN KEY ("operationId","connectionId") REFERENCES "IntegrationOperation"("id","connectionId") ON DELETE RESTRICT,
  CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL)),
  CHECK ("status" <> 'executing' OR ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND "attempt" > 0))
);
CREATE INDEX IF NOT EXISTS "IntegrationDelivery_retry" ON "IntegrationDelivery"("status","nextAttemptAt");
CREATE TRIGGER IF NOT EXISTS "IntegrationDelivery_identity_guard" BEFORE UPDATE ON "IntegrationDelivery"
WHEN NEW."connectionId" IS NOT OLD."connectionId" OR NEW."direction" IS NOT OLD."direction"
  OR NEW."channel" IS NOT OLD."channel" OR NEW."eventId" IS NOT OLD."eventId" OR NEW."payloadHash" IS NOT OLD."payloadHash"
BEGIN SELECT RAISE(ABORT, 'Delivery identity is immutable'); END;
`

export async function ensureIntegrationStorageSchema(db: DbClient): Promise<void> {
  try {
    // One synchronous SQLite exec contains the entire transaction; no JS await
    // can interleave unrelated work inside this migration transaction.
    await db.$executeRawUnsafe(`BEGIN IMMEDIATE; ${integrationStorageSchema} COMMIT;`)
  } catch (error) {
    try {
      await db.$executeRawUnsafe('ROLLBACK')
    } catch {
      // BEGIN may have failed before this connection opened a transaction.
    }
    throw error
  }
}
