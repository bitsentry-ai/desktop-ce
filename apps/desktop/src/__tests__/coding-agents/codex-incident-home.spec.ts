import { access, mkdtemp, mkdir, readlink, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { createIsolatedCodexIncidentHome } from '@bitsentry-ce/coding-agents/codex-incident-home'
import { setCodingAgentsLoggerForTesting } from '@bitsentry-ce/coding-agents/logger'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
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

  it('falls back to the real home with one warning when auth.json is unavailable', async () => {
    const userHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-user-home-'))
    temporaryDirectories.push(userHome)
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
      { reason: 'missing-auth-file' },
    ]])

    await fallback.dispose()
    await expect(access(userHome)).resolves.toBeUndefined()
  })
})
