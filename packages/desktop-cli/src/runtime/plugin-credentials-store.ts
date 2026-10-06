import { mkdir, open, readFile, rename, rm } from 'fs/promises'
import { withCredentialFileLock } from './credential-file-lock.js'
import { randomUUID } from 'node:crypto'
import { keychainPluginCredentialCipher } from './keychain-plugin-cipher.js'
import path from 'path'

import type {
  DesktopPluginStoredAuthRecord,
  DesktopPluginStoredAuthStore,
  DesktopPluginStoredAuthValue,
} from '@bitsentry-ce/core/features/plugins'

import { getRuntimeUserDataPath } from './runtime-paths'

type PluginAuthRecord = {
  values?: DesktopPluginStoredAuthRecord
  encryptedValues?: string
  updatedAt: string
}

type PluginCredentialsFile = {
  version: 1
  plugins: Record<string, PluginAuthRecord>
}

const STORE_VERSION = 1 as const

export interface PluginCredentialCipher {
  format?: 'keyring-v1'
  encrypt(value: string, recordId?: string): string
  decrypt(value: string, recordId?: string): string
}

export function electronPluginCredentialCipher(): PluginCredentialCipher {
  const unavailable = () =>
    new Error(
      'Secure plugin credential storage is unavailable. Open the Desktop app and retry through its local execution host, or configure a secure credential provider.',
    )
  try {
    const electron = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable(): boolean
        getSelectedStorageBackend?(): string
        encryptString(value: string): Buffer
        decryptString(value: Buffer): string
      }
    }
    const storage = electron.safeStorage
    if (
      !storage?.isEncryptionAvailable() ||
      (process.platform === 'linux' &&
        storage.getSelectedStorageBackend?.() === 'basic_text')
    )
      throw unavailable()
    return {
      encrypt: (value) => storage.encryptString(value).toString('base64'),
      decrypt: (value) => storage.decryptString(Buffer.from(value, 'base64')),
    }
  } catch {
    throw unavailable()
  }
}

function emptyStore(): PluginCredentialsFile {
  return {
    version: STORE_VERSION,
    plugins: {},
  }
}

function resolveStorePath(userDataPath?: string): string {
  const root = userDataPath ?? getRuntimeUserDataPath()
  return path.join(root, 'auth', 'plugins.json')
}

function cloneStoredAuthValue(
  value: DesktopPluginStoredAuthValue,
): DesktopPluginStoredAuthValue | undefined {
  if (typeof value === 'string') {
    if (value.trim().length === 0) {
      return undefined
    }

    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined
    }

    return value
  }

  if (typeof value === 'boolean' || value === null) {
    return value
  }

  try {
    return JSON.parse(JSON.stringify(value)) as DesktopPluginStoredAuthValue
  } catch {
    return undefined
  }
}

function normalizeStoredAuthRecord(
  values: DesktopPluginStoredAuthRecord,
): DesktopPluginStoredAuthRecord {
  const normalized: DesktopPluginStoredAuthRecord = Object.create(
    null,
  ) as DesktopPluginStoredAuthRecord

  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = key.trim()
    if (normalizedKey.length === 0) {
      continue
    }

    const normalizedValue = cloneStoredAuthValue(value)
    if (normalizedValue === undefined) {
      continue
    }

    normalized[normalizedKey] = normalizedValue
  }

  return normalized
}

function removePluginRecord(
  plugins: Record<string, PluginAuthRecord>,
  pluginId: string,
): Record<string, PluginAuthRecord> {
  const next: Record<string, PluginAuthRecord> = Object.create(null) as Record<
    string,
    PluginAuthRecord
  >

  for (const [key, value] of Object.entries(plugins)) {
    if (key === pluginId) {
      continue
    }

    next[key] = value
  }

  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const UNREADABLE_STORE_MESSAGE =
  'The plugin credential store could not be read because it is corrupt, unsupported, or inaccessible. Nothing was changed; fix or restore auth/plugins.json and retry.'

/**
 * Only a missing file is an empty store. Any other failure must stop the caller: writing on top of an
 * unreadable file would erase every other plugin's credentials.
 */
async function readStore(storePath: string): Promise<PluginCredentialsFile> {
  let raw: string
  try {
    raw = await readFile(storePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw new Error(UNREADABLE_STORE_MESSAGE)
  }

  // A parse error would quote part of the file, which holds credentials, so report a fixed message.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(UNREADABLE_STORE_MESSAGE)
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== STORE_VERSION ||
    !isRecord(parsed.plugins)
  ) {
    throw new Error(UNREADABLE_STORE_MESSAGE)
  }
  for (const record of Object.values(parsed.plugins)) {
    if (!isRecord(record) || typeof record.updatedAt !== 'string') {
      throw new Error(UNREADABLE_STORE_MESSAGE)
    }
    const plaintext = record.values !== undefined
    const encrypted =
      typeof record.encryptedValues === 'string' &&
      record.encryptedValues.length > 0
    if (plaintext === encrypted || (plaintext && !isRecord(record.values))) {
      throw new Error(UNREADABLE_STORE_MESSAGE)
    }
  }
  return {
    version: STORE_VERSION,
    plugins: parsed.plugins as Record<string, PluginAuthRecord>,
  }
}

async function writeStore(
  storePath: string,
  data: PluginCredentialsFile,
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 })
  const tempPath = `${storePath}.tmp-${randomUUID()}`
  try {
    const file = await open(tempPath, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(data, null, 2), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    // Never unlink the original as a fallback: failed replacement preserves it.
    await rename(tempPath, storePath)
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(storePath), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await rm(tempPath, { force: true })
  }
}

export class LocalPluginCredentialsStore implements DesktopPluginStoredAuthStore {
  private readonly storePath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    userDataPath?: string,
    private readonly cipherFactory: () => PluginCredentialCipher = () =>
      keychainPluginCredentialCipher(
        userDataPath ?? getRuntimeUserDataPath(),
        electronPluginCredentialCipher,
      ),
  ) {
    this.storePath = resolveStorePath(userDataPath)
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const locked = () => withCredentialFileLock(this.storePath, operation)
    const result = this.queue.then(locked, locked)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private decode(
    record: PluginAuthRecord,
    cipher: PluginCredentialCipher,
    id: string,
  ): DesktopPluginStoredAuthRecord {
    try {
      const raw: unknown = JSON.parse(
        cipher.decrypt(record.encryptedValues!, id),
      )
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid values')
      return normalizeStoredAuthRecord(raw as DesktopPluginStoredAuthRecord)
    } catch {
      throw new Error(
        'Plugin credentials could not be decrypted. Unlock the system credential store or restore access to the original device key. No data was changed.',
      )
    }
  }

  private encrypt(
    values: DesktopPluginStoredAuthRecord,
    cipher: PluginCredentialCipher,
    id: string,
  ): PluginAuthRecord {
    const serialized = JSON.stringify(values)
    const encryptedValues = cipher.encrypt(serialized, id)
    if (cipher.decrypt(encryptedValues, id) !== serialized)
      throw new Error(
        'Credential encryption verification failed; no data was changed.',
      )
    return { encryptedValues, updatedAt: new Date().toISOString() }
  }

  private migrate(
    store: PluginCredentialsFile,
    cipher: PluginCredentialCipher,
  ): boolean {
    // Verify all existing ciphertext before creating a replacement key or writing.
    const values = new Map<string, DesktopPluginStoredAuthRecord>()
    for (const [id, record] of Object.entries(store.plugins)) {
      values.set(
        id,
        record.values === undefined
          ? this.decode(record, cipher, id)
          : normalizeStoredAuthRecord(record.values),
      )
    }
    let changed = false
    for (const [id, record] of Object.entries(store.plugins)) {
      if (
        record.values === undefined &&
        !(
          cipher.format === 'keyring-v1' &&
          !record.encryptedValues?.startsWith('keyring:v1:')
        )
      )
        continue
      store.plugins[id] = this.encrypt(values.get(id)!, cipher, id)
      changed = true
    }
    return changed
  }

  /** Hold the credential file lock across the one-time SQLite cutover. */
  migrateIntegrationRecords(consume: (records: Record<string, DesktopPluginStoredAuthRecord>, cipher: {
    seal(id: string, value: string): string;
    saveAuth(id: string, values: DesktopPluginStoredAuthRecord): void;
    flush(): Promise<void>;
  }) => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const store = await readStore(this.storePath)
      if (!['bitsentry.integration-connections.v1', 'bitsentry.integration-resources.v1', 'bitsentry.integration-operations.v1'].some(key => Object.hasOwn(store.plugins, key))) return
      const cipher = this.cipherFactory()
      this.migrate(store, cipher)
      const keys = ['bitsentry.integration-connections.v1', 'bitsentry.integration-resources.v1', 'bitsentry.integration-operations.v1', 'bitsentry.integration-sqlite-cutover.v1']
      const records: Record<string, DesktopPluginStoredAuthRecord> = {}
      for (const key of keys) records[key] = store.plugins[key] ? this.decode(store.plugins[key], cipher, key) : {}
      await consume(records, {
        seal: (id, value) => {
          const encrypted = cipher.encrypt(value, `database:${id}`)
          if (cipher.decrypt(encrypted, `database:${id}`) !== value) throw new Error('Payload encryption verification failed')
          return encrypted
        },
        saveAuth: (id, values) => { store.plugins[id] = this.encrypt(values, cipher, id) },
        flush: () => writeStore(this.storePath, store),
      })
      // Originals remain encrypted for backup verification; no legacy record is cleared here.
      store.plugins['bitsentry.integration-sqlite-cutover.v1'] = this.encrypt({ completed: 'true' }, cipher, 'bitsentry.integration-sqlite-cutover.v1')
      await writeStore(this.storePath, store)
    })
  }

  /** Encrypt host database payloads using the same profile key and lock. */
  sealPayload(recordId: string, value: string): Promise<string> {
    return this.serial(async () => {
      const store = await readStore(this.storePath)
      const cipher = this.cipherFactory()
      if (this.migrate(store, cipher)) await writeStore(this.storePath, store)
      const encrypted = cipher.encrypt(value, `database:${recordId}`)
      if (cipher.decrypt(encrypted, `database:${recordId}`) !== value) throw new Error('Payload encryption verification failed')
      return encrypted
    })
  }

  openPayload(recordId: string, value: string): Promise<string> {
    return this.serial(async () => this.cipherFactory().decrypt(value, `database:${recordId}`))
  }

  get(pluginId: string): Promise<DesktopPluginStoredAuthRecord> {
    return this.serial(async () => {
      const store = await readStore(this.storePath)
      if (!Object.hasOwn(store.plugins, pluginId)) return {}
      const cipher = this.cipherFactory()
      if (this.migrate(store, cipher)) await writeStore(this.storePath, store)
      const record = store.plugins[pluginId]
      return record === undefined ? {} : this.decode(record, cipher, pluginId)
    })
  }

  set(
    pluginId: string,
    values: DesktopPluginStoredAuthRecord,
  ): Promise<DesktopPluginStoredAuthRecord> {
    return this.serial(async () => {
      const normalized = normalizeStoredAuthRecord(values)
      const store = await readStore(this.storePath)
      const cipher = this.cipherFactory()
      this.migrate(store, cipher)
      if (Object.keys(normalized).length === 0) {
        store.plugins = removePluginRecord(store.plugins, pluginId)
      } else {
        Object.defineProperty(store.plugins, pluginId, {
          value: this.encrypt(normalized, cipher, pluginId),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      await writeStore(this.storePath, store)
      return { ...normalized }
    })
  }

  clear(pluginId: string): Promise<void> {
    return this.serial(async () => {
      const store = await readStore(this.storePath)
      if (!Object.hasOwn(store.plugins, pluginId)) return
      const cipher = this.cipherFactory()
      this.migrate(store, cipher)
      store.plugins = removePluginRecord(store.plugins, pluginId)
      await writeStore(this.storePath, store)
    })
  }
}
