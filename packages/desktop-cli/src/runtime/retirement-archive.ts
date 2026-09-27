import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { LocalPluginCredentialsStore } from './plugin-credentials-store.js'
import { getRuntimeUserDataPath } from './runtime-paths.js'

export async function archiveRetiredDesktopData(payload: string): Promise<void> {
  const profile = getRuntimeUserDataPath()
  const directory = path.join(profile, 'retirement-archives')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const id = `retirement-v1-${randomUUID()}`
  const store = new LocalPluginCredentialsStore(profile)
  const encrypted = await store.sealPayload(id, payload)
  const archivePath = path.join(directory, `${id}.json`)
  const file = await open(archivePath, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ version: 1, id, encrypted })); await file.sync() } finally { await file.close() }
  if (process.platform !== 'win32') {
    const directoryHandle = await open(directory, 'r')
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  }
  const saved = JSON.parse(await readFile(archivePath, 'utf8')) as { id: string; encrypted: string }
  if (saved.id !== id || await store.openPayload(id, saved.encrypted) !== payload) throw new Error('Retirement archive verification failed; existing tables were retained')
}
