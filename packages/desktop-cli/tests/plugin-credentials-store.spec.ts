import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import * as fileSystem from 'fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocalPluginCredentialsStore,
  type PluginCredentialCipher,
} from '../src/runtime/plugin-credentials-store'

vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs/promises')>()
  return { ...original, rename: vi.fn(original.rename) }
})

// Test-only in-memory key. Production keys are managed by the OS, not files.
function cipher(): PluginCredentialCipher {
  const key = randomBytes(32)
  return {
    encrypt(value) {
      const iv = randomBytes(12)
      const encoder = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([
        encoder.update(value, 'utf8'),
        encoder.final(),
      ])
      return Buffer.concat([iv, encoder.getAuthTag(), data]).toString('base64')
    },
    decrypt(value) {
      const data = Buffer.from(value, 'base64')
      const decoder = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decoder.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([
        decoder.update(data.subarray(28)),
        decoder.final(),
      ]).toString('utf8')
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
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('migrates every legacy profile and supports reopening the encrypted file', async () => {
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        plugins: {
          github: {
            values: { token: 'first-secret' },
            updatedAt: '2026-09-27',
          },
          outline: {
            values: { token: 'second-secret' },
            updatedAt: '2026-09-27',
          },
        },
      }),
    )
    const encryption = cipher()
    const store = new LocalPluginCredentialsStore(directory, () => encryption)
    expect(await store.get('github')).toEqual({ token: 'first-secret' })
    const persisted = await readFile(filename, 'utf8')
    expect(persisted).not.toContain('first-secret')
    expect(persisted).not.toContain('second-secret')
    expect(persisted).not.toContain('"values"')
    expect(
      await new LocalPluginCredentialsStore(directory, () => encryption).get(
        'outline',
      ),
    ).toEqual({ token: 'second-secret' })
  })

  it('preserves the original if encryption is unavailable', async () => {
    const original = JSON.stringify({
      version: 1,
      plugins: {
        github: { values: { token: 'secret' }, updatedAt: '2026-09-27' },
      },
    })
    await writeFile(filename, original)
    const store = new LocalPluginCredentialsStore(directory, () => {
      throw new Error('locked')
    })
    await expect(store.get('github')).rejects.toThrow('locked')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })

  it('preserves encrypted input when the device key is unavailable', async () => {
    const store = new LocalPluginCredentialsStore(directory, cipher)
    const key = cipher()
    await new LocalPluginCredentialsStore(directory, () => key).set('github', {
      token: 'secret',
    })
    const original = await readFile(filename, 'utf8')
    await expect(store.get('github')).rejects.toThrow('decrypted')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })

  it('preserves a mixed legacy and encrypted store when an existing profile cannot be decrypted', async () => {
    const key = cipher()
    await new LocalPluginCredentialsStore(directory, () => key).set('github', {
      token: 'secret',
    })
    const mixed = JSON.parse(await readFile(filename, 'utf8')) as {
      plugins: Record<string, unknown>
    }
    mixed.plugins.outline = {
      values: { token: 'legacy-secret' },
      updatedAt: '2026-09-27',
    }
    const original = JSON.stringify(mixed)
    await writeFile(filename, original)
    const store = new LocalPluginCredentialsStore(directory, cipher)

    await expect(store.get('outline')).rejects.toThrow('decrypted')
    await expect(store.set('sentry', { token: 'new' })).rejects.toThrow(
      'decrypted',
    )
    await expect(store.clear('outline')).rejects.toThrow('decrypted')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })

  it('preserves legacy input when encryption does not round-trip', async () => {
    const original = JSON.stringify({
      version: 1,
      plugins: {
        github: { values: { token: 'legacy-secret' }, updatedAt: '2026-09-27' },
      },
    })
    await writeFile(filename, original)
    const key = cipher()
    const store = new LocalPluginCredentialsStore(directory, () => ({
      encrypt: key.encrypt,
      decrypt: () => 'different',
    }))

    await expect(store.get('github')).rejects.toThrow('verification failed')
    expect(await readFile(filename, 'utf8')).toBe(original)
  })

  it('preserves the original profile if Windows cannot replace the credential file', async () => {
    const original = JSON.stringify({
      version: 1,
      plugins: {
        github: { values: { token: 'legacy-secret' }, updatedAt: '2026-09-27' },
      },
    })
    await writeFile(filename, original)
    const originalPlatform = process.platform
    const replacement = vi
      .mocked(fileSystem.rename)
      .mockRejectedValue(new Error('File replacement failed'))
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const store = new LocalPluginCredentialsStore(directory, cipher)

      await expect(store.get('github')).rejects.toThrow(
        'File replacement failed',
      )
      expect(await readFile(filename, 'utf8')).toBe(original)
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      replacement.mockReset()
    }
  })
})

describe('plugin credential store', () => {
  let root: string
  let storePath: string
  let encryption: PluginCredentialCipher

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bitsentry-credentials-'))
    storePath = path.join(root, 'auth', 'plugins.json')
    encryption = cipher()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function seed(contents: string) {
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, contents, 'utf-8')
  }

  it('treats a missing file as an empty store and creates it on the first write', async () => {
    const store = new LocalPluginCredentialsStore(root, () => encryption)

    await expect(store.get('github')).resolves.toEqual({})
    await store.set('github', { token: 'first' })

    const persisted = await readFile(storePath, 'utf-8')
    expect(persisted).not.toContain('"values"')
    expect(persisted).not.toContain('"first"')
    await expect(
      new LocalPluginCredentialsStore(root, () => encryption).get('github'),
    ).resolves.toEqual({ token: 'first' })
  })

  it.each([
    [
      'malformed JSON',
      '{"version":1,"plugins":{"github":{"values":{"token":"keep-me"',
    ],
    ['a value that is not an object', '"keep-me"'],
    [
      'a plugins field that is not an object',
      '{"version":1,"plugins":["keep-me"]}',
    ],
    ['an unsupported version', '{"version":2,"plugins":{}}'],
    [
      'a profile without credentials',
      '{"version":1,"plugins":{"github":{"updatedAt":"2026-09-27"}}}',
    ],
  ])(
    'refuses to write over an unreadable store (%s) and leaves the file untouched',
    async (_label, contents) => {
      await seed(contents)
      const store = new LocalPluginCredentialsStore(root, () => encryption)

      await expect(store.set('sentry', { token: 'new' })).rejects.toThrow(
        'could not be read',
      )
      await expect(store.clear('github')).rejects.toThrow('could not be read')
      await expect(store.get('github')).rejects.toThrow('could not be read')

      expect(await readFile(storePath, 'utf-8')).toBe(contents)
    },
  )

  it('refuses to write when the file exists but cannot be read', async () => {
    // A directory where the file should be makes every read fail with something other than "missing".
    await mkdir(storePath, { recursive: true })
    const store = new LocalPluginCredentialsStore(root, () => encryption)

    await expect(store.set('sentry', { token: 'new' })).rejects.toThrow(
      'could not be read',
    )
    await expect(store.get('sentry')).rejects.toThrow('could not be read')
  })

  it('does not repeat any part of an unreadable file in its error', async () => {
    await seed('{"plugins":{"github":{"values":{"token":"super-secret-token"')

    const failure = await new LocalPluginCredentialsStore(
      root,
      () => encryption,
    )
      .set('sentry', { token: 'new' })
      .catch((error: unknown) => error)

    expect(String(failure)).not.toContain('super-secret-token')
  })

  it('keeps every write when stores on the same file save at the same time', async () => {
    const writers = [
      new LocalPluginCredentialsStore(root, () => encryption),
      new LocalPluginCredentialsStore(root, () => encryption),
    ]
    const ids = Array.from(
      { length: 24 },
      (_, index) => `plugin-${String(index)}`,
    )

    await Promise.all(
      ids.map((id, index) =>
        writers[index % 2]?.set(id, { token: `token-${id}` }),
      ),
    )

    const reader = new LocalPluginCredentialsStore(root, () => encryption)
    for (const id of ids) {
      await expect(reader.get(id)).resolves.toEqual({ token: `token-${id}` })
    }
  })

  it('does not restore an older snapshot of a record over a newer write', async () => {
    const operations = new LocalPluginCredentialsStore(root, () => encryption)
    const others = new LocalPluginCredentialsStore(root, () => encryption)
    await operations.set('operations', { status: 'proposed' })

    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        others.set(`other-${String(round)}`, { token: 'x' }),
        operations.set('operations', { status: `executing-${String(round)}` }),
      ])
    }

    await expect(operations.get('operations')).resolves.toEqual({
      status: 'executing-9',
    })
  })
})

describe('credential write coordination', () => {
  it('retains writes from independent store instances', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plugin-concurrent-'))
    try {
      const encryption = cipher()
      const stores = Array.from({ length: 12 }, () => new LocalPluginCredentialsStore(directory, () => encryption))
      await Promise.all(stores.map((store, index) => store.set(`profile-${index}`, { token: `secret-${index}` })))
      for (let index = 0; index < stores.length; index++) {
        expect(await stores[index].get(`profile-${index}`)).toEqual({ token: `secret-${index}` })
      }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('treats prototype-like profile names as ordinary data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'plugin-keys-'))
    try {
      const encryption = cipher()
      const store = new LocalPluginCredentialsStore(directory, () => encryption)
      await store.set('__proto__', { token: 'secret' })
      expect(await store.get('__proto__')).toEqual({ token: 'secret' })
      await store.clear('__proto__')
      expect(await store.get('__proto__')).toEqual({})
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
