import { access, mkdtemp, mkdir, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  symlink: vi.fn(),
}))

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  symlink: mocks.symlink,
}))

const { symlink: realSymlink } = await vi.importActual<typeof import('fs/promises')>('fs/promises')

import { createIsolatedCodexIncidentHome } from '@bitsentry-ce/coding-agents/codex-incident-home'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

beforeEach(() => {
  mocks.symlink.mockImplementation(realSymlink)
})

describe('createIsolatedCodexIncidentHome', () => {
  it('links authentication and session logs but omits global configuration', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-user-home-'))
    temporaryDirectories.push(userHome)
    const codexHome = path.join(userHome, '.codex')
    const authPath = path.join(codexHome, 'auth.json')
    const configPath = path.join(codexHome, 'config.toml')
    const sessionsPath = path.join(codexHome, 'sessions')
    await mkdir(sessionsPath, { recursive: true })
    await writeFile(authPath, '{}')
    await writeFile(configPath, 'model_provider = "custom"')

    const isolated = await createIsolatedCodexIncidentHome(userHome)
    try {
      expect(await readlink(path.join(isolated.home, '.codex', 'auth.json'))).toBe(authPath)
      await expect(access(path.join(isolated.home, '.codex', 'config.toml'))).rejects.toThrow()
      expect(await readlink(path.join(isolated.home, '.codex', 'sessions'))).toBe(sessionsPath)
      await expect(access(path.join(isolated.home, '.codex', 'AGENTS.md'))).rejects.toThrow()
    } finally {
      await isolated.dispose()
    }
    await expect(access(isolated.home)).rejects.toThrow()
  })

  it('keeps keychain or environment-authenticated sessions isolated when auth.json is unavailable', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-user-home-'))
    temporaryDirectories.push(userHome)
    const warnings: unknown[][] = []
    setCodingAgentsLoggerForTesting({
      info: () => {},
      warn: (...args) => { warnings.push(args) },
      error: () => {},
    })

    const isolated = await createIsolatedCodexIncidentHome(userHome)
    expect(isolated.home).not.toBe(userHome)
    await expect(access(path.join(isolated.home, '.codex', 'auth.json'))).rejects.toThrow()
    expect(warnings).toEqual([])

    await isolated.dispose()
    await expect(access(isolated.home)).rejects.toThrow()
    await expect(access(userHome)).resolves.toBeUndefined()
  })

  it('uses the OS home when HOME is unavailable', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-user-home-'))
    temporaryDirectories.push(userHome)
    await mkdir(path.join(userHome, '.codex'), { recursive: true })
    await writeFile(path.join(userHome, '.codex', 'auth.json'), '{}')
    vi.spyOn(os, 'homedir').mockReturnValue(userHome)

    const isolated = await createIsolatedCodexIncidentHome('')
    try {
      expect(await readlink(path.join(isolated.home, '.codex', 'auth.json'))).toBe(
        path.join(userHome, '.codex', 'auth.json'),
      )
    } finally {
      await isolated.dispose()
    }
  })

  it('falls back to the real home when isolation links cannot be created', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-user-home-'))
    temporaryDirectories.push(userHome)
    const authPath = path.join(userHome, '.codex', 'auth.json')
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(authPath, '{}')
    mocks.symlink.mockRejectedValueOnce(Object.assign(new Error('symlink denied'), { code: 'EPERM' }))
    const warnings: unknown[][] = []
    setCodingAgentsLoggerForTesting({
      info: () => {},
      warn: (...args) => { warnings.push(args) },
      error: () => {},
    })

    const fallback = await createIsolatedCodexIncidentHome(userHome)
    expect(fallback.home).toBe(userHome)
    expect(warnings).toEqual([[
      '[codex-provider] isolated HOME unavailable; using the real HOME for this incident session',
      { reason: 'link-failed' },
    ]])
    await fallback.dispose()
  })
})
