import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { PluginCredentialCipher } from './plugin-credentials-store.js'

const PREFIX = 'keyring:v1:'
type KeyEntry = { getPassword(): string | null; setPassword(value: string): void }

function createSystemEntry(account: string): KeyEntry {
  const runtimeRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const unpackedLoader = resourcesPath === undefined ? undefined :
    path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@napi-rs', 'keyring', 'index.js')
  // Explicit physical path: optional bindings copied after packing are absent
  // from app.asar's virtual filesystem index. Both GUI and CLI use this loader.
  const modulePath = unpackedLoader !== undefined && existsSync(unpackedLoader) ?
    unpackedLoader : '@napi-rs/keyring'
  const { Entry } = runtimeRequire(modulePath) as {
    Entry: new (service: string, account: string, options: { linux: { store: 'secret-service' } }) => KeyEntry
  }
  return new Entry('BitSentry Plugin Credentials', account, { linux: { store: 'secret-service' } })
}

/** One OS-protected key per product-local profile; key creation requires the file lock. */
export function keychainPluginCredentialCipher(
  userDataPath: string,
  legacyCipher: () => PluginCredentialCipher,
  createEntry: (account: string) => KeyEntry = createSystemEntry,
): PluginCredentialCipher {
  const account = createHash('sha256').update(realpathSync(userDataPath)).digest('hex')
  let entry: KeyEntry | undefined
  function key(create: boolean): Buffer {
    try {
      entry ??= createEntry(account)
      let value = entry.getPassword()
      if (value === null) {
        if (!create) throw new Error('Missing profile key')
        value = randomBytes(32).toString('hex')
        entry.setPassword(value)
        if (entry.getPassword() !== value) throw new Error('Key verification failed')
      }
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid profile key')
      return Buffer.from(value, 'hex')
    } catch {
      throw new Error('The system keychain is unavailable, locked, or missing this profile key. Unlock the original keychain; Linux requires a persistent Secret Service. No plaintext fallback is available.')
    }
  }
  return {
    format: 'keyring-v1',
    encrypt(value, recordId) {
      const iv = randomBytes(12)
      const encoder = createCipheriv('aes-256-gcm', key(true), iv)
      encoder.setAAD(Buffer.from(JSON.stringify({ account, recordId })))
      const data = Buffer.concat([encoder.update(value, 'utf8'), encoder.final()])
      return PREFIX + Buffer.concat([iv, encoder.getAuthTag(), data]).toString('base64')
    },
    decrypt(value, recordId) {
      if (!value.startsWith(PREFIX)) return legacyCipher().decrypt(value)
      const data = Buffer.from(value.slice(PREFIX.length), 'base64')
      if (data.length < 28) throw new Error('Invalid encrypted credential')
      const decoder = createDecipheriv('aes-256-gcm', key(false), data.subarray(0, 12))
      decoder.setAAD(Buffer.from(JSON.stringify({ account, recordId })))
      decoder.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decoder.update(data.subarray(28)), decoder.final()]).toString('utf8')
    },
  }
}
