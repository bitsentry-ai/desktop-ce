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

async function readStore(storePath: string): Promise<PluginCredentialsFile> {
  try {
    const raw = await readFile(storePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PluginCredentialsFile>
    return {
      version: STORE_VERSION,
      plugins: parsed.plugins ?? {},
    }
  } catch {
    return emptyStore()
  }
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
    const store = await readStore(this.storePath)
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
  }

  async clear(pluginId: string): Promise<void> {
    const store = await readStore(this.storePath)
    if (store.plugins[pluginId] === undefined) {
      return
    }

    store.plugins = removePluginRecord(store.plugins, pluginId)
    await writeStore(this.storePath, store)
  }
}
