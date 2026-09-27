import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { keychainPluginCredentialCipher } from '../src/runtime/keychain-plugin-cipher'
import { LocalPluginCredentialsStore } from '../src/runtime/plugin-credentials-store'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))) })
async function profile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'keychain-profile-'))
  directories.push(directory)
  return directory
}
const unavailableLegacy = () => { throw new Error('Open Desktop once to migrate legacy encryption') }

describe('shared GUI and CLI keychain encryption', () => {
  it('reopens ciphertext and binds it to its profile and record identity', async () => {
    const directory = await profile()
    const passwords = new Map<string, string>()
    const entry = (account: string) => ({
      getPassword: () => passwords.get(account) ?? null,
      setPassword: (value: string) => { passwords.set(account, value) },
    })
    const first = keychainPluginCredentialCipher(directory, unavailableLegacy, entry)
    const encrypted = first.encrypt('private-token', 'connection-a')
    expect(encrypted).not.toContain('private-token')
    const reopened = keychainPluginCredentialCipher(directory, unavailableLegacy, entry)
    expect(reopened.decrypt(encrypted, 'connection-a')).toBe('private-token')
    expect(() => reopened.decrypt(encrypted, 'connection-b')).toThrow()
    const other = keychainPluginCredentialCipher(await profile(), unavailableLegacy, entry)
    expect(() => other.decrypt(encrypted, 'connection-a')).toThrow()
    expect(passwords.size).toBe(1)
  })

  it('does not replace a missing key while existing ciphertext still needs it', async () => {
    const directory = await profile()
    let password: string | null = null
    let writes = 0
    const entry = () => ({ getPassword: () => password, setPassword: (value: string) => { password = value; writes++ } })
    const factory = () => keychainPluginCredentialCipher(directory, unavailableLegacy, entry)
    const store = new LocalPluginCredentialsStore(directory, factory)
    await store.set('first', { token: 'secret' })
    password = null
    await expect(store.set('second', { token: 'another' })).rejects.toThrow()
    expect(writes).toBe(1)
  })

  it('fails closed when the OS credential store cannot be read', async () => {
    const encryption = keychainPluginCredentialCipher(await profile(), unavailableLegacy, () => ({
      getPassword: () => { throw new Error('locked') },
      setPassword: () => { throw new Error('must not write') },
    }))
    expect(() => encryption.encrypt('secret', 'connection')).toThrow('system keychain')
  })
})
