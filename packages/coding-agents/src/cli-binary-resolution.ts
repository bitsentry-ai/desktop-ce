import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

function stripWrappingQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '')
}

function existingFile(candidate: string | null | undefined): string | null {
  if (candidate === null || candidate === undefined || candidate === '') return null
  try {
    if (statSync(candidate).isFile()) {
      return candidate
    }

    return null
  } catch {
    return null
  }
}

function uniqueCandidates(candidates: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue
    let normalized = candidate
    if (process.platform === 'win32') {
      normalized = candidate.toLowerCase()
    }

    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(candidate)
  }
  return result
}

function addAppDataCandidates(candidates: string[], appData: string | undefined): void {
  if (appData !== undefined && appData !== '') {
    candidates.push(path.join(appData, 'npm'))
  }
}

function addLocalAppDataCandidates(candidates: string[], localAppData: string | undefined): void {
  if (localAppData === undefined || localAppData === '') {
    return
  }

  candidates.push(path.join(localAppData, 'pnpm'), path.join(localAppData, 'Programs', 'nodejs'), path.join(localAppData, 'Volta', 'bin'))
}

function addUserProfileCandidates(candidates: string[], userProfile: string | undefined): void {
  if (userProfile === undefined || userProfile === '') {
    return
  }

  candidates.push(path.join(userProfile, '.bun', 'bin'), path.join(userProfile, 'scoop', 'shims'))
}

function getWindowsCliDirs(): string[] {
  if (process.platform !== 'win32') return []

  const appData = process.env.APPDATA?.trim()
  const localAppData = process.env.LOCALAPPDATA?.trim()
  const userProfile = process.env.USERPROFILE?.trim()

  const candidates: string[] = []
  addAppDataCandidates(candidates, appData)
  addLocalAppDataCandidates(candidates, localAppData)
  addUserProfileCandidates(candidates, userProfile)

  return uniqueCandidates(candidates)
}

function addOpenCodeDirectoryCandidates(candidates: string[], trimmed: string): void {
  if (!existsSync(trimmed)) {
    return
  }

  candidates.push(
    path.join(trimmed, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(trimmed, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(trimmed, 'opencode.exe'),
    path.join(trimmed, 'opencode.cmd'),
    path.join(trimmed, 'opencode'),
    path.join(trimmed, 'npm', 'opencode.exe'),
    path.join(trimmed, 'npm', 'opencode.cmd'),
  )
}

function isOpenCodeCommandName(normalized: string): boolean {
  return normalized === 'opencode' ||
    normalized.endsWith('\\opencode') ||
    normalized.endsWith('/opencode') ||
    normalized.endsWith('\\opencode.cmd') ||
    normalized.endsWith('/opencode.cmd')
}

function getOpenCodeWindowsCandidates(binaryPath: string): string[] {
  const trimmed = stripWrappingQuotes(binaryPath)
  const normalized = trimmed.toLowerCase()
  const dirname = path.dirname(trimmed)
  const candidates: string[] = []
  if (normalized.endsWith('\\opencode.cmd') || normalized.endsWith('/opencode.cmd')) {
    candidates.push(path.join(dirname, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  }

  addOpenCodeDirectoryCandidates(candidates, trimmed)

  const cliDirCandidates = getWindowsCliDirs().flatMap((cliDir) => [
    path.join(cliDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(cliDir, 'opencode.exe'),
    path.join(cliDir, 'opencode.cmd'),
    path.join(cliDir, 'opencode'),
  ])

  if (isOpenCodeCommandName(normalized)) {
    candidates.push(...cliDirCandidates)
  }

  return uniqueCandidates(candidates)
}

export function createCommandInvocation(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    return { command, args }
  }
  if (path.extname(command).toLowerCase() === '.exe') {
    return { command, args }
  }
  const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(' ')
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
}

function quoteWindowsCmdArgument(value: string): string {
  const escaped = value
    .replace(/\r?\n/g, ' ')
    .replace(/(["^&|<>()%!])/g, '^$1')
  return `"${escaped}"`
}

export function resolveOpenCodeWindowsBinary(binaryPath: string): string {
  if (process.platform !== 'win32') return binaryPath
  const trimmed = stripWrappingQuotes(binaryPath)

  for (const candidate of getOpenCodeWindowsCandidates(trimmed)) {
    const file = existingFile(candidate)
    if (file !== null) return file
  }

  return trimmed
}
