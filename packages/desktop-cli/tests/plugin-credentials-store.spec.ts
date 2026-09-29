import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalPluginCredentialsStore } from '../src/runtime/plugin-credentials-store'

describe('plugin credential store', () => {
  let root: string
  let storePath: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bitsentry-credentials-'))
    storePath = path.join(root, 'auth', 'plugins.json')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function seed(contents: string) {
    await mkdir(path.dirname(storePath), { recursive: true })
    await writeFile(storePath, contents, 'utf-8')
  }

  it('treats a missing file as an empty store and creates it on the first write', async () => {
    const store = new LocalPluginCredentialsStore(root)

    await expect(store.get('github')).resolves.toEqual({})
    await store.set('github', { token: 'first' })

    await expect(new LocalPluginCredentialsStore(root).get('github')).resolves.toEqual({ token: 'first' })
  })

  it.each([
    ['malformed JSON', '{"version":1,"plugins":{"github":{"values":{"token":"keep-me"'],
    ['a value that is not an object', '"keep-me"'],
    ['a plugins field that is not an object', '{"version":1,"plugins":["keep-me"]}'],
  ])('refuses to write over an unreadable store (%s) and leaves the file untouched', async (_label, contents) => {
    await seed(contents)
    const store = new LocalPluginCredentialsStore(root)

    await expect(store.set('sentry', { token: 'new' })).rejects.toThrow('could not be read')
    await expect(store.clear('github')).rejects.toThrow('could not be read')
    await expect(store.get('github')).rejects.toThrow('could not be read')

    expect(await readFile(storePath, 'utf-8')).toBe(contents)
  })

  it('refuses to write when the file exists but cannot be read', async () => {
    // A directory where the file should be makes every read fail with something other than "missing".
    await mkdir(storePath, { recursive: true })
    const store = new LocalPluginCredentialsStore(root)

    await expect(store.set('sentry', { token: 'new' })).rejects.toThrow('could not be read')
    await expect(store.get('sentry')).rejects.toThrow('could not be read')
  })

  it('does not repeat any part of an unreadable file in its error', async () => {
    await seed('{"plugins":{"github":{"values":{"token":"super-secret-token"')

    const failure = await new LocalPluginCredentialsStore(root).set('sentry', { token: 'new' }).catch((error: unknown) => error)

    expect(String(failure)).not.toContain('super-secret-token')
  })

  it('keeps every write when stores on the same file save at the same time', async () => {
    const writers = [new LocalPluginCredentialsStore(root), new LocalPluginCredentialsStore(root)]
    const ids = Array.from({ length: 24 }, (_, index) => `plugin-${String(index)}`)

    await Promise.all(ids.map((id, index) => writers[index % 2]?.set(id, { token: `token-${id}` })))

    const reader = new LocalPluginCredentialsStore(root)
    for (const id of ids) {
      await expect(reader.get(id)).resolves.toEqual({ token: `token-${id}` })
    }
  })

  it('does not restore an older snapshot of a record over a newer write', async () => {
    const operations = new LocalPluginCredentialsStore(root)
    const others = new LocalPluginCredentialsStore(root)
    await operations.set('operations', { status: 'proposed' })

    for (let round = 0; round < 10; round += 1) {
      await Promise.all([
        others.set(`other-${String(round)}`, { token: 'x' }),
        operations.set('operations', { status: `executing-${String(round)}` }),
      ])
    }

    await expect(operations.get('operations')).resolves.toEqual({ status: 'executing-9' })
  })
})
