import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import path from 'path'

import type {
  DesktopPluginStoredAuthRecord,
  DesktopPluginStoredAuthStore,
  DesktopPluginStoredAuthValue,
} from '@bitsentry-ce/core/features/plugins'

import { getRuntimeUserDataPath } from './runtime-paths'

type PluginAuthRecord = {
  values: DesktopPluginStoredAuthRecord
  updatedAt: string
}

type PluginCredentialsFile = {
  version: 1
  plugins: Record<string, PluginAuthRecord>
}

const STORE_VERSION = 1 as const

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
  'The plugin credential store could not be read. Nothing was changed; fix or restore auth/plugins.json and retry.'

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
  if (!isRecord(parsed) || (parsed.plugins !== undefined && !isRecord(parsed.plugins))) {
    throw new Error(UNREADABLE_STORE_MESSAGE)
  }
  return {
    version: STORE_VERSION,
    plugins: (parsed.plugins ?? {}) as Record<string, PluginAuthRecord>,
  }
}

// Every read-modify-write of one file runs one at a time, across all store instances in this process.
// A second process writing the same file at the same moment is not covered by this lock.
const storeLocks = new Map<string, Promise<void>>()

async function withStoreLock<T>(storePath: string, task: () => Promise<T>): Promise<T> {
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

async function writeStore(storePath: string, data: PluginCredentialsFile): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true })

  const payload = JSON.stringify(data, null, 2)
  const tempPath = `${storePath}.tmp-${String(process.pid)}-${String(Date.now())}`
  await writeFile(tempPath, payload, { encoding: 'utf-8', mode: 0o600 })

  try {
    await rename(tempPath, storePath)
  } catch (error) {
    if (process.platform === 'win32') {
      await rm(storePath, { force: true })
      await rename(tempPath, storePath)
      return
    }

    throw error
  }
}

export class LocalPluginCredentialsStore implements DesktopPluginStoredAuthStore {
  private readonly storePath: string

  constructor(userDataPath?: string) {
    this.storePath = resolveStorePath(userDataPath)
  }

  async get(pluginId: string): Promise<DesktopPluginStoredAuthRecord> {
    // Reads wait for in-flight writes: some platforms briefly have no file while a write replaces it.
    const store = await withStoreLock(this.storePath, () => readStore(this.storePath))
    const values = store.plugins[pluginId]?.values
    if (values === undefined) {
      return {}
    }

    return { ...values }
  }

  async set(
    pluginId: string,
    values: DesktopPluginStoredAuthRecord,
  ): Promise<DesktopPluginStoredAuthRecord> {
    const normalized = normalizeStoredAuthRecord(values)
    return withStoreLock(this.storePath, async () => {
      const store = await readStore(this.storePath)

      if (Object.keys(normalized).length === 0) {
        store.plugins = removePluginRecord(store.plugins, pluginId)
        await writeStore(this.storePath, store)
        return {}
      }

      store.plugins[pluginId] = {
        values: normalized,
        updatedAt: new Date().toISOString(),
      }
      await writeStore(this.storePath, store)
      return { ...normalized }
    })
  }

  clear(pluginId: string): Promise<void> {
    return withStoreLock(this.storePath, async () => {
      const store = await readStore(this.storePath)
      if (store.plugins[pluginId] === undefined) {
        return
      }

      store.plugins = removePluginRecord(store.plugins, pluginId)
      await writeStore(this.storePath, store)
    })
  }
}
