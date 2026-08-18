import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import {
  ErrorSourceCredentialsStore,
  migrateLegacyErrorSourceCredentials,
} from "../main/platform/app/electron/error-source-credentials-store";
import type { DbClient } from "@bitsentry-ce/core/features/desktop/desktop-database-client";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

function createDb() {
  const now = new Date().toISOString();
  const row = {
    id: "source-1",
    sourceType: "sentry",
    name: "Sentry",
    accessTokenRef: "token-that-must-not-remain-in-sqlite",
    refreshTokenRef: "refresh-token-that-must-not-remain-in-sqlite",
    expiresAt: null,
    grantedScopes: JSON.stringify([]),
    configuration: JSON.stringify({}),
    logLevelThreshold: "error",
    additionalMetadata: null,
    syncEnabled: true,
    autoDiagnosisEnabled: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    createdAt: now,
    updatedAt: now,
  };
  const update = vi.fn().mockResolvedValue(row);
  return {
    db: {
      errorSource: {
        findMany: vi.fn().mockResolvedValue([row]),
        update,
      },
    } as unknown as DbClient,
    update,
  };
}

describe("ErrorSourceCredentialsStore", () => {
  it("migrates legacy tokens into encrypted storage and clears the SQLite fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bitsentry-error-source-"));
    temporaryDirectories.push(directory);
    const { db, update } = createDb();
    const credentialsStore = new ErrorSourceCredentialsStore(directory);

    await migrateLegacyErrorSourceCredentials(db, credentialsStore);

    await expect(credentialsStore.get("source-1")).resolves.toEqual({
      accessToken: "token-that-must-not-remain-in-sqlite",
      refreshToken: "refresh-token-that-must-not-remain-in-sqlite",
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "source-1" },
      data: {
        accessTokenRef: null,
        refreshTokenRef: null,
      },
    });
    const encryptedFile = await readFile(
      path.join(directory, "auth", "error-sources.json"),
      "utf8",
    );
    expect(encryptedFile).not.toContain("token-that-must-not-remain-in-sqlite");
    expect(encryptedFile).not.toContain("refresh-token-that-must-not-remain-in-sqlite");
  });
});
