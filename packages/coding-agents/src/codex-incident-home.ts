import { access, lstat, mkdir, mkdtemp, rm, symlink } from 'fs/promises'
import os from 'os'
import path from 'path'
import { codingAgentsLogger as log } from './logger.js'

export interface IsolatedCodexIncidentHome {
  home: string
  dispose(): Promise<void>
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Codex resolves its global instructions relative to HOME. Incident sessions
 * get an otherwise-empty temporary home, with authentication and session log
 * storage linked from the user's real home. The user's config.toml is omitted
 * intentionally so incident sessions do not inherit global plugins or AGENTS.
 */
export async function createIsolatedCodexIncidentHome(
  userHome: string | undefined = process.env.HOME,
): Promise<IsolatedCodexIncidentHome> {
  if (userHome === undefined || userHome.length === 0) {
    throw new Error('Codex incident sessions require HOME to isolate provider context')
  }

  const sourceCodexHome = path.join(userHome, '.codex')
  const authPath = path.join(sourceCodexHome, 'auth.json')
  if (!await exists(authPath)) {
    log.warn(
      '[codex-provider] isolated HOME unavailable; using the real HOME for this incident session',
      { reason: 'missing-auth-file' },
    )
    return {
      home: userHome,
      dispose: async () => {},
    }
  }

  const isolatedHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-codex-home-'))
  try {
    const isolatedCodexHome = path.join(isolatedHome, '.codex')
    await mkdir(isolatedCodexHome)
    await symlink(authPath, path.join(isolatedCodexHome, 'auth.json'))

    const sessionsPath = path.join(sourceCodexHome, 'sessions')
    if (await exists(sessionsPath)) {
      const metadata = await lstat(sessionsPath)
      if (metadata.isDirectory() || metadata.isSymbolicLink()) {
        await symlink(sessionsPath, path.join(isolatedCodexHome, 'sessions'))
      }
    }

    return {
      home: isolatedHome,
      dispose: () => rm(isolatedHome, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(isolatedHome, { recursive: true, force: true })
    throw error
  }
}
