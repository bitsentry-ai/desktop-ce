import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { randomUUID } from 'node:crypto'
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
  encrypt(value: string): string
  decrypt(value: string): string
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
  const normalized: DesktopPluginStoredAuthRecord = {}

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
  const next: Record<string, PluginAuthRecord> = {}

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

// Every read-modify-write of one file runs one at a time, across all store instances in this process.
// A second process writing the same file at the same moment is not covered by this lock.
const storeLocks = new Map<string, Promise<void>>()

async function withStoreLock<T>(
  storePath: string,
  task: () => Promise<T>,
): Promise<T> {
  const run = (storeLocks.get(storePath) ?? Promise.resolve()).then(task)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  storeLocks.set(storePath, tail)
  void tail.then(() => {
    if (storeLocks.get(storePath) === tail) storeLocks.delete(storePath)
  })
  return run
}

async function writeStore(
  storePath: string,
  data: PluginCredentialsFile,
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true })

  const payload = JSON.stringify(data, null, 2)
  const tempPath = `${storePath}.tmp-${randomUUID()}`
  await writeFile(tempPath, payload, { encoding: 'utf-8', mode: 0o600 })

  await rename(tempPath, storePath)
}

export class LocalPluginCredentialsStore implements DesktopPluginStoredAuthStore {
  private readonly storePath: string

  constructor(
    userDataPath?: string,
    private readonly cipherFactory: () => PluginCredentialCipher = electronPluginCredentialCipher,
  ) {
    this.storePath = resolveStorePath(userDataPath)
  }

  private decode(
    record: PluginAuthRecord,
    cipher: PluginCredentialCipher,
  ): DesktopPluginStoredAuthRecord {
    try {
      const raw: unknown = JSON.parse(cipher.decrypt(record.encryptedValues!))
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
  ): PluginAuthRecord {
    const serialized = JSON.stringify(values)
    const encryptedValues = cipher.encrypt(serialized)
    if (cipher.decrypt(encryptedValues) !== serialized)
      throw new Error(
        'Credential encryption verification failed; no data was changed.',
      )
    return { encryptedValues, updatedAt: new Date().toISOString() }
  }

  private migrate(
    store: PluginCredentialsFile,
    cipher: PluginCredentialCipher,
  ): boolean {
    let changed = false
    for (const [id, record] of Object.entries(store.plugins)) {
      if (record.values === undefined) {
        this.decode(record, cipher)
        continue
      }
      store.plugins[id] = this.encrypt(
        normalizeStoredAuthRecord(record.values),
        cipher,
      )
      changed = true
    }
    return changed
  }

  get(pluginId: string): Promise<DesktopPluginStoredAuthRecord> {
    return withStoreLock(this.storePath, async () => {
      const store = await readStore(this.storePath)
      if (!Object.hasOwn(store.plugins, pluginId)) return {}
      const cipher = this.cipherFactory()
      if (this.migrate(store, cipher)) await writeStore(this.storePath, store)
      const record = store.plugins[pluginId]
      return record === undefined ? {} : this.decode(record, cipher)
    })
  }

  set(
    pluginId: string,
    values: DesktopPluginStoredAuthRecord,
  ): Promise<DesktopPluginStoredAuthRecord> {
    return withStoreLock(this.storePath, async () => {
      const normalized = normalizeStoredAuthRecord(values)
      const store = await readStore(this.storePath)
      const cipher = this.cipherFactory()
      this.migrate(store, cipher)
      if (Object.keys(normalized).length === 0) {
        store.plugins = removePluginRecord(store.plugins, pluginId)
      } else {
        store.plugins[pluginId] = this.encrypt(normalized, cipher)
      }
      await writeStore(this.storePath, store)
      return { ...normalized }
    })
  }

  clear(pluginId: string): Promise<void> {
    return withStoreLock(this.storePath, async () => {
      const store = await readStore(this.storePath)
      if (store.plugins[pluginId] === undefined) return
      const cipher = this.cipherFactory()
      this.migrate(store, cipher)
      store.plugins = removePluginRecord(store.plugins, pluginId)
      await writeStore(this.storePath, store)
    })
  }
}
