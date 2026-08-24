import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import path from "path";
import { safeStorage } from "electron";

import {
  type ErrorSourceCredentials,
  type ErrorSourceCredentialsStore as ErrorSourceCredentialsStoreContract,
} from "@bitsentry-ce/core/features/error-sources";
import { SqliteErrorSourcesRepositoryAdapter } from "@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter";
import type { DbClient } from "@bitsentry-ce/core/features/desktop/desktop-database-client";

type StoredCredential = { encryptedValue: string };
type CredentialsFile = { version: 1; sources: Record<string, StoredCredential> };

function removeCredential(
  sources: Record<string, StoredCredential>,
  sourceId: string,
): Record<string, StoredCredential> {
  return Object.fromEntries(
    Object.entries(sources).filter(([key]) => key !== sourceId),
  );
}

function emptyStore(): CredentialsFile {
  return { version: 1, sources: {} };
}

async function readStore(storePath: string): Promise<CredentialsFile> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<CredentialsFile>;
    return { version: 1, sources: parsed.sources ?? {} };
  } catch {
    return emptyStore();
  }
}

async function writeStore(storePath: string, data: CredentialsFile): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  const temporaryPath = `${storePath}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await writeFile(temporaryPath, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporaryPath, storePath);
  } catch (error) {
    if (process.platform !== "win32") throw error;
    await rm(storePath, { force: true });
    await rename(temporaryPath, storePath);
  }
}

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Error-source credential encryption is unavailable on this device.");
  }
}

export class ErrorSourceCredentialsStore implements ErrorSourceCredentialsStoreContract {
  private readonly storePath: string;

  constructor(userDataPath: string) {
    this.storePath = path.join(userDataPath, "auth", "error-sources.json");
  }

  async get(sourceId: string): Promise<ErrorSourceCredentials> {
    const record = (await readStore(this.storePath)).sources[sourceId];
    if (record === undefined) return { accessToken: null, refreshToken: null };
    try {
      assertEncryptionAvailable();
      const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(record.encryptedValue, "base64"))) as Partial<ErrorSourceCredentials>;
      return {
        accessToken: typeof parsed.accessToken === "string" && parsed.accessToken.trim().length > 0 ? parsed.accessToken : null,
        refreshToken: typeof parsed.refreshToken === "string" && parsed.refreshToken.trim().length > 0 ? parsed.refreshToken : null,
      };
    } catch {
      return { accessToken: null, refreshToken: null };
    }
  }

  async set(sourceId: string, credentials: ErrorSourceCredentials): Promise<void> {
    assertEncryptionAvailable();
    const store = await readStore(this.storePath);
    if (credentials.accessToken === null && credentials.refreshToken === null) {
      store.sources = removeCredential(store.sources, sourceId);
    } else {
      store.sources[sourceId] = {
        encryptedValue: safeStorage.encryptString(JSON.stringify(credentials)).toString("base64"),
      };
    }
    await writeStore(this.storePath, store);
  }

  async clear(sourceId: string): Promise<void> {
    const store = await readStore(this.storePath);
    if (store.sources[sourceId] === undefined) return;
    store.sources = removeCredential(store.sources, sourceId);
    await writeStore(this.storePath, store);
  }
}

export async function migrateLegacyErrorSourceCredentials(
  db: DbClient,
  credentialsStore: ErrorSourceCredentialsStoreContract,
): Promise<void> {
  const repository = new SqliteErrorSourcesRepositoryAdapter(db);
  for (const source of await repository.findMany()) {
    if (source.accessTokenRef === null && source.refreshTokenRef === null) continue;
    await credentialsStore.set(source.id, {
      accessToken: source.accessTokenRef,
      refreshToken: source.refreshTokenRef,
    });
    await repository.update({
      id: source.id,
      accessTokenRef: null,
      refreshTokenRef: null,
    });
  }
}
