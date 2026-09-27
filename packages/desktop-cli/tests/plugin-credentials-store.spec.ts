import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalPluginCredentialsStore, type PluginCredentialCipher } from '../src/runtime/plugin-credentials-store'

// Test-only in-memory key. Production keys are managed by the OS, not files.
function cipher(): PluginCredentialCipher {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const encoder = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([encoder.update(value, 'utf8'), encoder.final()])
      return Buffer.concat([iv, encoder.getAuthTag(), data]).toString('base64')
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64')
      const decoder = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decoder.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decoder.update(data.subarray(28)), decoder.final()]).toString('utf8')
    },
  }
}

describe('encrypted plugin profiles', () => {
  let directory: string
  let filename: string
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'plugin-credentials-'))
    filename = path.join(directory, 'auth', 'plugins.json')
    await mkdir(path.dirname(filename))
  })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  it('migrates every legacy profile and supports reopening the encrypted file', async () => {
    await writeFile(filename, JSON.stringify({ version: 1, plugins: {
      github: { values: { token: 'first-secret' }, updatedAt: '2026-09-27' },
      outline: { values: { token: 'second-secret' }, updatedAt: '2026-09-27' },
    } }))
    const encryption = cipher()
    const store = new LocalPluginCredentialsStore(directory, () => encryption)
    expect(await store.get('github')).toEqual({ token: 'first-secret' })
    const persisted = await readFile(filename, 'utf8')
    expect(persisted).not.toContain('first-secret')
    expect(persisted).not.toContain('second-secret')
    expect(persisted).not.toContain('"values"')
    expect(await new LocalPluginCredentialsStore(directory, () => encryption).get('outline')).toEqual({ token: 'second-secret' })
  })

  it('preserves the original if encryption is unavailable', async () => {
    const original = JSON.stringify({ version: 1, plugins: { github: { values: { token: 'secret' }, updatedAt: '2026-09-27' } } })
    await writeFile(filename, original)
    const store = new LocalPluginCredentialsStore(directory, () => { throw new Error('locked') })
    await expect(store.get('github')).rejects.toThrow('locked')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })

  it('does not overwrite corrupt input or conceal decryption failure', async () => {
    const store = new LocalPluginCredentialsStore(directory, cipher)
    await writeFile(filename, '{broken')
    await expect(store.set('github', { token: 'new' })).rejects.toThrow('corrupt')
    expect(await readFile(filename, 'utf8')).toBe('{broken')
    await rm(filename)
    const key = cipher()
    await new LocalPluginCredentialsStore(directory, () => key).set('github', { token: 'secret' })
    const original = await readFile(filename, 'utf8')
    await expect(store.get('github')).rejects.toThrow('decrypted')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })
})
