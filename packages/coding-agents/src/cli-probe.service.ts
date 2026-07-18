import { execFile, spawn, spawnSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import readline from 'readline'
import { access, constants, readdir } from 'fs/promises'
import path from 'path'
import type { CLIProbeResult, CLIProbeErrorKind } from './types'
import { createClaudeCodeSubscriptionEnv } from './claude-code-env'
import { createCodingAgentsProcessEnv } from './coding-agents-process-env'
import { resolveOpenCodeWindowsBinary } from './cli-binary-resolution'
import {
  buildWindowsCmdCommandLine,
  getEnvValue,
  getWindowsCmdExecutable,
  isWindowsCmdShim,
} from './windows-cmd'
import { codingAgentsLogger as log } from './logger'
export { setCodingAgentsLoggerForTesting } from './logger'

const WINDOWS_PREFERRED_PATHEXT = ['.cmd', '.exe', '.bat']

type ProbeProvider = 'claude_code' | 'codex' | 'opencode' | 'cursor'

const PROVIDER_BINARY_NAMES: Record<ProbeProvider, string> = {
  claude_code: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor-agent',
}
const CLAUDE_UNAUTHENTICATED_MARKERS = [
  'not logged in',
  'login required',
  'run `claude login`',
  'run claude login',
  'unauthenticated',
  'authentication required',
  'not authenticated',
]
const OPEN_CODE_UNAUTHENTICATED_MARKERS = [
  'not logged in',
  'not authenticated',
  'no authenticated',
  'login required',
]
const OPEN_CODE_AUTHENTICATED_PATTERN =
  /authenticated|logged in|api key|oauth|anthropic|openai|openrouter|google|gemini/i
const CURSOR_UNAUTHENTICATED_MARKERS = [
  'not logged in',
  'not authenticated',
  'login required',
  'sign in',
  'run cursor-agent login',
  'unauthenticated',
  'authentication required',
  'authentication failed',
  'expired',
]
const CURSOR_AUTHENTICATED_MARKERS = [
  'logged in',
  'login successful',
  'authenticated',
  'signed in',
]

class CLIProbeError extends Error {
  constructor(
    message: string,
    readonly kind: CLIProbeErrorKind,
    readonly code: unknown = null,
    readonly stdout = '',
    readonly stderr = '',
    readonly exitCode: number | null = null,
  ) {
    super(message)
    this.name = 'CLIProbeError'
  }
}

function toProbeError(error: unknown, fallbackKind: CLIProbeErrorKind): CLIProbeError {
  if (error instanceof CLIProbeError) return error
  if (error instanceof Error) return new CLIProbeError(error.message, fallbackKind)
  return new CLIProbeError(String(error), fallbackKind)
}

function getUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  const parsed: unknown = JSON.parse(value)
  return getUnknownRecord(parsed)
}

function includesAny(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => value.includes(marker))
}

function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    } catch {
      // Fall through to direct kill
    }
  }
  child.kill()
}

const PROBE_TIMEOUT_MS = 5_000
const CODEX_PROBE_TIMEOUT_MS = 10_000
const CURSOR_ACP_PROBE_TIMEOUT_MS = 10_000

function getPlatformPath(): typeof path.win32   {
  if (process.platform === 'win32') return path.win32
  return path.posix
}

function getHomeDir(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform === 'win32') {
    return getEnvValue(env, 'USERPROFILE') ?? getEnvValue(env, 'HOME')
  }

  return getEnvValue(env, 'HOME')
}

function expandHomeDir(inputPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const homeDir = getHomeDir(env)

  if (inputPath === '~') {
    return homeDir ?? inputPath
  }

  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return getPlatformPath().join(homeDir ?? '~', inputPath.slice(2))
  }

  return inputPath
}

function isExplicitBinaryPath(binaryPath: string): boolean {
  const platformPath = getPlatformPath()

  if (platformPath.isAbsolute(binaryPath)) return true
  if (hasRelativeBinaryPrefix(binaryPath)) return true
  return hasPathSeparator(binaryPath)
}

function hasRelativeBinaryPrefix(binaryPath: string): boolean {
  return (
    binaryPath.startsWith('./') ||
    binaryPath.startsWith('../') ||
    binaryPath.startsWith('~/') ||
    binaryPath.startsWith('.\\') ||
    binaryPath.startsWith('..\\')
  )
}

function hasPathSeparator(binaryPath: string): boolean {
  if (binaryPath.includes(path.sep)) return true
  if (path.sep !== '/' && binaryPath.includes('/')) return true
  return path.sep !== '\\' && binaryPath.includes('\\')
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }

  return unique
}

function describeProbeError(error: unknown): Record<string, unknown> {
  const probeError = toProbeError(error, 'not_executable')
  return {
    kind: probeError.kind,
    code: probeError.code,
    message: probeError.message,
    exitCode: probeError.exitCode,
    stderr: probeError.stderr.slice(0, 1_000),
  }
}

function getWindowsPathext(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = getEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  const parsed = configured
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension !== '')
    .map((extension) => {
      if (extension.startsWith('.')) return extension
      return `.${extension}`
    })

  return uniqueValues([
    ...WINDOWS_PREFERRED_PATHEXT,
    ...parsed,
  ])
}

function hasWindowsExecutableExtension(binaryPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const extension = path.win32.extname(binaryPath).toLowerCase()
  if (extension === '') return false

  return getWindowsPathext(env).includes(extension)
}

function expandWindowsPathextCandidates(binaryPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'win32' || path.win32.extname(binaryPath) !== '') {
    return [binaryPath]
  }

  return uniqueValues([
    ...getWindowsPathext(env).map((extension) => `${binaryPath}${extension}`),
    binaryPath,
  ])
}

async function resolveExplicitBinaryCandidates(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  let candidates = [binaryPath]
  if (process.platform === 'win32') {
    candidates = expandWindowsPathextCandidates(binaryPath, env)
  }
  const accessible: string[] = []

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      accessible.push(candidate)
    } catch {
      // Try the next extension candidate.
    }
  }

  return accessible
}

async function resolveBinaryCandidates(
  binaryPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const trimmed = binaryPath.trim()
  if (trimmed === '') return []

  const expanded = expandHomeDir(trimmed, env)
  if (isExplicitBinaryPath(expanded)) {
    return resolveExplicitBinaryCandidates(expanded, env)
  }

  let resolverCommand = 'which'
  if (process.platform === 'win32') {
    resolverCommand = 'where'
  }
  try {
    const result = await runCommand(
      resolverCommand,
      [expanded],
      PROBE_TIMEOUT_MS,
      env,
    )
    const resolved = uniqueValues(`${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0))

    return resolved
  } catch {
    // Fall through to known install locations
  }

  return []
}

function getFallbackBinaryCandidates(
  binaryName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates = [binaryName]

  addUnixFallbackCandidates(candidates, binaryName, env)
  addWindowsFallbackCandidates(candidates, binaryName, env)
  addNpmPrefixCandidate(candidates, binaryName, env)

  return uniqueValues(candidates)
}

function addUnixFallbackCandidates(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  if (process.platform === 'win32') return

  const platformPath = getPlatformPath()
  const homeDir = getHomeDir(env)
  candidates.push(`/opt/homebrew/bin/${binaryName}`, `/usr/local/bin/${binaryName}`)

  if (homeDir !== undefined) {
    candidates.push(
      platformPath.join(homeDir, '.local', 'bin', binaryName),
      platformPath.join(homeDir, '.cargo', 'bin', binaryName),
    )
  }
}

function addWindowsFallbackCandidates(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  if (process.platform !== 'win32') return

  addWindowsAppDataCandidates(candidates, binaryName, env)
  addWindowsLocalAppDataCandidates(candidates, binaryName, env)
  addWindowsUserProfileCandidates(candidates, binaryName, env)
}

function addWindowsAppDataCandidates(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  const appData = getEnvValue(env, 'APPDATA')
  if (appData === undefined) return

  const npmBin = path.win32.join(appData, 'npm')
  if (binaryName === 'opencode') {
    candidates.push(path.win32.join(npmBin, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  }
  candidates.push(
    path.win32.join(npmBin, `${binaryName}.cmd`),
    path.win32.join(npmBin, binaryName),
  )
}

function addWindowsLocalAppDataCandidates(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  const localAppData = getEnvValue(env, 'LOCALAPPDATA')
  if (localAppData === undefined) return

  candidates.push(
    path.win32.join(localAppData, 'pnpm', `${binaryName}.cmd`),
    path.win32.join(localAppData, 'pnpm', binaryName),
    path.win32.join(localAppData, 'Volta', 'bin', `${binaryName}.exe`),
    path.win32.join(localAppData, 'Volta', 'bin', `${binaryName}.cmd`),
  )
}

function addWindowsUserProfileCandidates(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  const userProfile = getEnvValue(env, 'USERPROFILE')
  if (userProfile === undefined) return

  candidates.push(
    path.win32.join(userProfile, '.bun', 'bin', `${binaryName}.exe`),
    path.win32.join(userProfile, '.bun', 'bin', binaryName),
    path.win32.join(userProfile, 'scoop', 'shims', `${binaryName}.exe`),
    path.win32.join(userProfile, 'scoop', 'shims', `${binaryName}.cmd`),
  )
}

function addNpmPrefixCandidate(
  candidates: string[],
  binaryName: string,
  env: NodeJS.ProcessEnv,
): void {
  const npmPrefix = getEnvValue(env, 'npm_config_prefix')
  if (npmPrefix === undefined) return

  if (process.platform === 'win32') {
    candidates.push(path.win32.join(npmPrefix, `${binaryName}.cmd`))
    return
  }

  candidates.push(path.posix.join(npmPrefix, 'bin', binaryName))
}

async function listWindowsSubdirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.info('[local-ai] Skipping Windows CLI directory scan', {
        root,
        code: code ?? null,
      })
    }
    return []
  }
}

async function getWinGetPackageCandidates(
  root: string,
  packagePrefix: string,
  executableName: string,
): Promise<string[]> {
  const prefix = packagePrefix.toLowerCase()
  const packageDirs = await listWindowsSubdirectories(root)
  return packageDirs
    .filter((dir) => dir.toLowerCase().startsWith(prefix))
    .map((dir) => path.win32.join(root, dir, executableName))
}

async function getWindowsAppsCodexCandidates(): Promise<string[]> {
  const root = 'C:\\Program Files\\WindowsApps'
  const packageDirs = await listWindowsSubdirectories(root)
  return packageDirs
    .filter((dir) => dir.toLowerCase().startsWith('openai.codex_'))
    .map((dir) => path.win32.join(root, dir, 'app', 'resources', 'codex.exe'))
}

async function getProviderKnownWindowsCandidates(
  provider: ProbeProvider,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (process.platform !== 'win32') return []

  const localAppData = getEnvValue(env, 'LOCALAPPDATA')
  if (provider === 'codex') {
    const candidates = await getWindowsAppsCodexCandidates()
    if (localAppData !== undefined) {
      candidates.push(
        path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
        path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe'),
      )
    }
    return uniqueValues(candidates)
  }

  if (localAppData === undefined) return []

  const winGetRoot = path.win32.join(localAppData, 'Microsoft', 'WinGet', 'Packages')
  if (provider === 'claude_code') {
    return getWinGetPackageCandidates(winGetRoot, 'Anthropic.ClaudeCode_', 'claude.exe')
  }
  if (provider === 'cursor') {
    return []
  }
  return getWinGetPackageCandidates(winGetRoot, 'SST.opencode_', 'opencode.exe')
}

async function resolveProviderBinaryPath(
  provider: ProbeProvider,
  preferredBinaryPath?: string,
): Promise<string | null> {
  const binaryName = PROVIDER_BINARY_NAMES[provider]
  log.info('[local-ai] coding agent detection started', {
    provider,
    preferredBinaryPathPresent: preferredBinaryPath !== undefined && preferredBinaryPath !== '',
  })

  const candidates = uniqueValues([
    preferredBinaryPath,
    ...getFallbackBinaryCandidates(binaryName),
    ...await getProviderKnownWindowsCandidates(provider),
  ])

  for (const candidate of candidates) {
    const resolvedCandidates = await resolveBinaryCandidates(candidate)

    for (const resolved of resolvedCandidates) {
      let executablePath = resolved
      if (provider === 'opencode') {
        executablePath = resolveOpenCodeWindowsBinary(resolved)
      }

      try {
        await runCommand(executablePath, ['--version'], PROBE_TIMEOUT_MS)
        log.info('[local-ai] coding agent detection resolved', {
          provider,
          candidate,
          resolvedCommand: executablePath,
          args: ['--version'],
        })
        return executablePath
      } catch (error) {
        log.warn('[local-ai] coding agent detection candidate failed', {
          provider,
          candidate,
          resolvedCommand: executablePath,
          args: ['--version'],
          ...describeProbeError(error),
        })
        continue
      }
    }
  }

  log.warn('[local-ai] coding agent detection failed', {
    provider,
    candidates,
  })
  return null
}

function createWindowsCmdInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  return {
    command: getWindowsCmdExecutable(env),
    args: ['/d', '/s', '/c', buildWindowsCmdCommandLine(command, args)],
  }
}

function shouldRetryWithWindowsShell(command: string, error: unknown): boolean {
  if (process.platform !== 'win32') return false
  if (isExplicitBinaryPath(command)) return false
  if (hasWindowsExecutableExtension(command)) return false

  const probeError = toProbeError(error, 'not_executable')
  const code = probeError.code ?? probeError.kind

  return code === 'ENOENT' || code === 'EACCES' || code === 'not_installed' || code === 'not_executable'
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const commandEnv = createCodingAgentsProcessEnv(env ?? process.env)
  const shouldUseWindowsCmd = process.platform === 'win32' && isWindowsCmdShim(command)
  let initialInvocation = { command, args }
  if (shouldUseWindowsCmd) {
    initialInvocation = createWindowsCmdInvocation(command, args, commandEnv)
  }

  return runCommandInvocation(initialInvocation.command, initialInvocation.args, timeoutMs, commandEnv, command)
    .catch((error: unknown) => {
      if (!shouldRetryWithWindowsShell(command, error)) {
        throw error
      }

      const retryInvocation = createWindowsCmdInvocation(command, args, commandEnv)
      return runCommandInvocation(retryInvocation.command, retryInvocation.args, timeoutMs, commandEnv, command)
    })
}

function runCommandInvocation(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  displayCommand: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      timeout: timeoutMs,
      env,
    }, (error, stdout, stderr) => {
      const probeError = getCommandProbeError(error, child.exitCode, displayCommand, timeoutMs, stdout, stderr)
      if (probeError !== undefined) {
        reject(probeError)
        return
      }

      resolve({
        stdout,
        stderr,
        exitCode: child.exitCode,
      })
    })
  })
}

function getCommandProbeError(
  error: Error | null,
  childExitCode: number | null,
  displayCommand: string,
  timeoutMs: number,
  stdout: string,
  stderr: string,
): CLIProbeError | undefined {
  if (error === null) return undefined

  const errno = (error as NodeJS.ErrnoException).code
  let exitCode = childExitCode
  if (typeof errno === 'number') {
    exitCode = errno
  }
  const errnoProbeError = getErrnoProbeError(displayCommand, errno)
  if (errnoProbeError !== undefined) return errnoProbeError

  if ('killed' in error && error.killed === true) {
    return createTimedOutProbeError(displayCommand, timeoutMs, errno)
  }
  if (exitCode !== null && exitCode !== 0) {
    return createExitCodeProbeError(displayCommand, errno, stdout, stderr, exitCode)
  }

  return undefined
}

function getErrnoProbeError(
  displayCommand: string,
  errno: string | number | undefined,
): CLIProbeError | undefined {
  if (errno === 'ENOENT') {
    return new CLIProbeError(`${displayCommand} not found on PATH`, 'not_installed', errno)
  }
  if (errno === 'EACCES') {
    return new CLIProbeError(`${displayCommand} is not executable`, 'not_executable', errno)
  }

  return undefined
}

function createTimedOutProbeError(
  displayCommand: string,
  timeoutMs: number,
  errno: string | number | undefined,
): CLIProbeError {
  return new CLIProbeError(`${displayCommand} timed out after ${String(timeoutMs)}ms`, 'timed_out', errno)
}

function createExitCodeProbeError(
  displayCommand: string,
  errno: string | number | undefined,
  stdout: string,
  stderr: string,
  exitCode: number,
): CLIProbeError {
  return new CLIProbeError(
    `${displayCommand} exited with code ${String(exitCode)}`,
    'not_executable',
    errno,
    stdout,
    stderr,
    exitCode,
  )
}

function parseClaudeAuthOutput(stdout: string, stderr: string): CLIProbeResult['auth'] {
  const combined = `${stdout}\n${stderr}`.toLowerCase()
  if (includesAny(combined, CLAUDE_UNAUTHENTICATED_MARKERS)) {
    return { status: 'unauthenticated' }
  }

  try {
    const parsed = parseJsonRecord(stdout.trim())
    const authStatus = authStatusFromRecordFlags(parsed)
    if (authStatus !== undefined) {
      return authStatus
    }
  } catch {
    // Not JSON, fall through
  }

  if (combined.includes('authenticated') || combined.includes('logged in')) {
    return { status: 'authenticated' }
  }

  return { status: 'unknown' }
}

function parseVersion(output: string): string | null {
  const trimmed = output.trim()
  const match = trimmed.match(/(\d+\.\d+[\w.-]*)/)
  if (match !== null) return match[1]
  if (trimmed !== '') return trimmed
  return null
}

function versionOutput(result: { stdout: string; stderr: string }): string {
  if (result.stdout !== '') return result.stdout
  return result.stderr
}

function probeStatusFromAuth(auth: CLIProbeResult['auth']): CLIProbeResult['status'] {
  if (auth.status === 'authenticated') return 'ready'
  return 'warning'
}

function authWarningMessage(auth: CLIProbeResult['auth'], providerName: string): string | undefined {
  if (auth.status === 'unknown') {
    return `Could not verify ${providerName} authentication status.`
  }

  return undefined
}

function authStatusFromRecordFlags(record: Record<string, unknown> | undefined): CLIProbeResult['auth'] | undefined {
  if (record === undefined) return undefined
  if (record.authenticated === true || record.loggedIn === true || record.auth === true) {
    return { status: 'authenticated' }
  }
  if (record.authenticated === false || record.loggedIn === false) {
    return { status: 'unauthenticated' }
  }
  return undefined
}

export async function probeClaudeCode(binaryPath: string): Promise<CLIProbeResult> {
  const resolvedBinaryPath = await resolveProviderBinaryPath('claude_code', binaryPath)
  if (resolvedBinaryPath === null) {
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: 'not_installed',
      message: `${binaryPath} not found or not executable`,
    }
  }

  let version: string | null = null
  let auth: CLIProbeResult['auth'] = { status: 'unknown' }

  try {
    const versionResult = await runCommand(resolvedBinaryPath, ['--version'], PROBE_TIMEOUT_MS)
    version = parseVersion(versionOutput(versionResult))
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_installed')
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: error.kind,
      message: error.message,
    }
  }

  try {
    const authResult = await runCommand(
      resolvedBinaryPath,
      ['auth', 'status'],
      PROBE_TIMEOUT_MS,
      createClaudeCodeSubscriptionEnv(process.env),
    )
    auth = parseClaudeAuthOutput(authResult.stdout, authResult.stderr)
  } catch (err: unknown) {
    // claude auth status exits non-zero when not logged in — parse the output anyway
    const error = toProbeError(err, 'not_executable')
    if (error.stdout !== '' || error.stderr !== '') {
      auth = parseClaudeAuthOutput(error.stdout, error.stderr)
    } else {
      auth = { status: 'unknown' }
    }
  }

  if (auth.status === 'unauthenticated') {
    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind: 'unauthenticated',
      message: 'Claude Code is not authenticated. Run `claude auth login` and try again.',
    }
  }

  return {
    installed: true,
    version,
    auth,
    status: probeStatusFromAuth(auth),
    message: authWarningMessage(auth, 'Claude Code'),
  }
}

export async function probeCodex(binaryPath: string, args?: string[]): Promise<CLIProbeResult> {
  const resolvedBinaryPath = await resolveProviderBinaryPath('codex', binaryPath)
  if (resolvedBinaryPath === null) {
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: 'not_installed',
      message: `${binaryPath} not found or not executable`,
    }
  }

  let version: string | null = null

  try {
    const versionResult = await runCommand(resolvedBinaryPath, ['--version'], PROBE_TIMEOUT_MS)
    version = parseVersion(versionOutput(versionResult))
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_installed')
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: error.kind,
      message: error.message,
    }
  }

  let auth: CLIProbeResult['auth'] = { status: 'unknown' }
  try {
    auth = await probeCodexAccount(resolvedBinaryPath, args)
  } catch (err: unknown) {
    const message = getErrorMessage(err)
    const lowerMessage = message.toLowerCase()
    const errorKind = codexProbeErrorKindFromMessage(lowerMessage)

    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind,
      message: `Codex app-server probe failed: ${message}`,
    }
  }

  if (auth.status === 'unauthenticated') {
    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind: 'unauthenticated',
      message: 'Codex is not authenticated. Run `codex login` and try again.',
    }
  }

  return {
    installed: true,
    version,
    auth,
    status: probeStatusFromAuth(auth),
    message: authWarningMessage(auth, 'Codex'),
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function codexProbeErrorKindFromMessage(lowerMessage: string): CLIProbeErrorKind {
  return appServerProbeErrorKindFromMessage(lowerMessage)
}

function appServerProbeErrorKindFromMessage(lowerMessage: string): CLIProbeErrorKind {
  if (lowerMessage.includes('timed out')) return 'timed_out'
  if (lowerMessage.includes('exited before') || lowerMessage.includes('subprocess')) {
    return 'subprocess_exited'
  }
  return 'app_server_init_failed'
}

function parseOpenCodeAuthOutput(stdout: string, stderr: string): CLIProbeResult['auth'] {
  const combined = `${stdout}\n${stderr}`.trim()
  const lower = combined.toLowerCase()
  if (includesAny(lower, OPEN_CODE_UNAUTHENTICATED_MARKERS)) {
    return { status: 'unauthenticated' }
  }

  if (combined === '') {
    return { status: 'unknown' }
  }

  const jsonAuthStatus = parseOpenCodeJsonAuth(stdout)
  if (jsonAuthStatus !== undefined) return jsonAuthStatus

  return parseOpenCodeTextAuth(combined)
}

function parseOpenCodeJsonAuth(stdout: string): CLIProbeResult['auth'] | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim())
    if (Array.isArray(parsed)) {
      if (parsed.length > 0) return { status: 'authenticated' }
      return { status: 'unauthenticated' }
    }

    return parseOpenCodeRecordAuth(getUnknownRecord(parsed))
  } catch {
    return undefined
  }
}

function parseOpenCodeRecordAuth(record: Record<string, unknown> | undefined): CLIProbeResult['auth'] | undefined {
  if (record === undefined) return undefined

  const providers = getOpenCodeAuthenticatedProviders(record)
  if (providers !== undefined) {
    if (providers.length > 0) return { status: 'authenticated' }
    return { status: 'unauthenticated' }
  }

  return authStatusFromRecordFlags(record)
}

function parseOpenCodeTextAuth(combined: string): CLIProbeResult['auth'] {
  const nonEmptyLines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^provider\b/i.test(line))

  if (nonEmptyLines.some((line) => OPEN_CODE_AUTHENTICATED_PATTERN.test(line))) {
    return { status: 'authenticated' }
  }

  return { status: 'unknown' }
}

function parseOpenCodeModelIds(stdout: string, stderr: string): string[] {
  const models = new Set<string>()
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || /^provider\b/i.test(trimmed)) continue
    const match = trimmed.match(/[a-z0-9_.-]+\/[a-z0-9_.:|+-]+/i)
    if (match !== null) models.add(match[0])
  }
  return [...models]
}

function getOpenCodeAuthenticatedProviders(record: Record<string, unknown>): unknown[] | undefined {
  const providers = getUnknownArray(record.providers)
  if (providers !== undefined) return providers
  return getUnknownArray(record.authenticated)
}

function getUnknownArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  const array: unknown[] = value
  return array
}

function getRpcErrorMessage(value: unknown): string {
  const record = getUnknownRecord(value)
  if (typeof record?.message === 'string') return record.message
  return JSON.stringify(value)
}

function hasCursorLoginAuthMethod(value: unknown): boolean {
  const record = getUnknownRecord(value)
  return record?.id === 'cursor_login'
}

function childExitMessage(command: string, code: number | null, signal: NodeJS.Signals | null): string {
  return `${command} exited before probe completed (code=${String(code)}, signal=${String(signal)})`
}

export function parseCursorAuthOutput(stdout: string, stderr: string): CLIProbeResult['auth'] {
  const combined = `${stdout}\n${stderr}`.trim()
  const lower = combined.toLowerCase()
  if (includesAny(lower, CURSOR_UNAUTHENTICATED_MARKERS)) {
    return { status: 'unauthenticated' }
  }

  if (combined === '') {
    return { status: 'unknown' }
  }

  try {
    const authStatus = authStatusFromRecordFlags(parseJsonRecord(stdout.trim()))
    if (authStatus !== undefined) {
      return authStatus
    }
  } catch {
    // Not JSON, fall through to text parsing.
  }

  if (includesAny(lower, CURSOR_AUTHENTICATED_MARKERS)) {
    return { status: 'authenticated' }
  }

  return { status: 'unknown' }
}

function mergeCursorAuthSignals(
  primary: CLIProbeResult['auth'],
  secondary: CLIProbeResult['auth'],
): CLIProbeResult['auth'] {
  if (secondary.status === 'unauthenticated') return secondary
  if (primary.status !== 'unknown') return primary
  return secondary
}

function hasUsableOpenCodeFreeModels(stdout: string, stderr: string): boolean {
  return parseOpenCodeModelIds(stdout, stderr).some((model) =>
    /^opencode\/.+(?:free|pickle)/i.test(model),
  )
}

export async function probeCursor(binaryPath: string): Promise<CLIProbeResult> {
  const resolvedBinaryPath = await resolveProviderBinaryPath('cursor', binaryPath)
  if (resolvedBinaryPath === null) {
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: 'not_installed',
      message: `${binaryPath} not found or not executable`,
    }
  }

  let version: string | null = null

  try {
    const versionResult = await runCommand(resolvedBinaryPath, ['--version'], PROBE_TIMEOUT_MS)
    version = parseVersion(versionOutput(versionResult))
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_installed')
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: error.kind,
      message: error.message,
    }
  }

  let auth: CLIProbeResult['auth'] = { status: 'unknown' }
  try {
    const authResult = await runCommand(resolvedBinaryPath, ['status'], PROBE_TIMEOUT_MS)
    auth = parseCursorAuthOutput(authResult.stdout, authResult.stderr)
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_executable')
    auth = parseCursorAuthOutput(error.stdout, error.stderr)
  }

  try {
    const aboutResult = await runCommand(resolvedBinaryPath, ['about'], PROBE_TIMEOUT_MS)
    auth = mergeCursorAuthSignals(
      auth,
      parseCursorAuthOutput(aboutResult.stdout, aboutResult.stderr),
    )
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_executable')
    auth = mergeCursorAuthSignals(
      auth,
      parseCursorAuthOutput(error.stdout, error.stderr),
    )
  }

  if (auth.status === 'unauthenticated') {
    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind: 'unauthenticated',
      message: 'Cursor Agent is not authenticated. Run `cursor-agent login` and try again.',
    }
  }

  try {
    await probeCursorAcp(resolvedBinaryPath)
  } catch (err: unknown) {
    const message = getErrorMessage(err)
    const lowerMessage = message.toLowerCase()
    const errorKind = cursorProbeErrorKindFromMessage(lowerMessage)

    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind,
      message: `Cursor ACP probe failed: ${message}`,
    }
  }

  return {
    installed: true,
    version,
    auth,
    status: probeStatusFromAuth(auth),
    message: authWarningMessage(auth, 'Cursor Agent'),
  }
}

function cursorProbeErrorKindFromMessage(lowerMessage: string): CLIProbeErrorKind {
  return appServerProbeErrorKindFromMessage(lowerMessage)
}

export async function probeOpenCode(binaryPath: string, args?: string[]): Promise<CLIProbeResult> {
  const resolvedBinaryPath = await resolveProviderBinaryPath('opencode', binaryPath)
  if (resolvedBinaryPath === null) {
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: 'not_installed',
      message: `${binaryPath} not found or not executable`,
    }
  }

  let version: string | null = null

  try {
    const versionResult = await runCommand(resolvedBinaryPath, ['--version'], PROBE_TIMEOUT_MS)
    version = parseVersion(versionOutput(versionResult))
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_installed')
    return {
      installed: false,
      version: null,
      auth: { status: 'unknown' },
      status: 'error',
      errorKind: error.kind,
      message: error.message,
    }
  }

  let auth = await getOpenCodeAuth(resolvedBinaryPath, args)

  let hasFreeModels = false
  if (auth.status !== 'authenticated') {
    hasFreeModels = await hasOpenCodeFreeModels(resolvedBinaryPath, args)
    if (hasFreeModels) {
      auth = { status: 'authenticated' }
    }
  }

  if (auth.status === 'unauthenticated') {
    return {
      installed: true,
      version,
      auth,
      status: 'error',
      errorKind: 'unauthenticated',
      message: 'OpenCode is not authenticated. Run `opencode auth login` and try again.',
    }
  }

  return {
    installed: true,
    version,
    auth,
    status: probeStatusFromAuth(auth),
    message: openCodeProbeMessage(auth, hasFreeModels),
  }
}

function openCodeProbeMessage(auth: CLIProbeResult['auth'], hasFreeModels: boolean): string | undefined {
  if (hasFreeModels) return 'OpenCode free hosted models are available.'
  return authWarningMessage(auth, 'OpenCode')
}

async function getOpenCodeAuth(
  resolvedBinaryPath: string,
  args: string[] | undefined,
): Promise<CLIProbeResult['auth']> {
  try {
    const authResult = await runCommand(resolvedBinaryPath, [...(args ?? []), 'auth', 'list'], PROBE_TIMEOUT_MS)
    return parseOpenCodeAuthOutput(authResult.stdout, authResult.stderr)
  } catch (err: unknown) {
    const error = toProbeError(err, 'not_executable')
    return parseOpenCodeAuthOutput(error.stdout, error.stderr)
  }
}

async function hasOpenCodeFreeModels(
  resolvedBinaryPath: string,
  args: string[] | undefined,
): Promise<boolean> {
  try {
    const modelsResult = await runCommand(resolvedBinaryPath, [...(args ?? []), 'models'], PROBE_TIMEOUT_MS)
    return hasUsableOpenCodeFreeModels(modelsResult.stdout, modelsResult.stderr)
  } catch {
    return false
  }
}

function handleCursorInitializeResponse(
  parsed: Record<string, unknown>,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  if (parsed.error !== undefined) {
    reject(new Error(`Cursor initialize failed: ${getRpcErrorMessage(parsed.error)}`))
    return
  }

  const result = getUnknownRecord(parsed.result)
  if (result === undefined) {
    reject(new Error('Cursor initialize returned an invalid response'))
    return
  }

  const authMethods = getUnknownArray(result.authMethods) ?? []
  if (authMethods.some(hasCursorLoginAuthMethod)) {
    // Authentication can open Cursor's browser login flow. Probes must be
    // passive; execution can authenticate when the user intentionally runs it.
    resolve()
    return
  }

  resolve()
}

function parseProbeLine(line: string): Record<string, unknown> | undefined {
  try {
    return parseJsonRecord(line)
  } catch {
    return undefined
  }
}

function authStatusFromCodexError(error: unknown): CLIProbeResult['auth'] {
  const message = getRpcErrorMessage(error).toLowerCase()
  if (message.includes('not logged in') || message.includes('unauthenticated')) {
    return { status: 'unauthenticated' }
  }

  return { status: 'unknown' }
}

function authStatusFromCodexAccount(result: Record<string, unknown> | undefined): CLIProbeResult['auth'] {
  if (result === undefined) return { status: 'unknown' }

  const account = getUnknownRecord(result.account)
  if (isAuthenticatedCodexAccount(result, account)) return { status: 'authenticated' }
  if (result.requiresOpenaiAuth === false) return { status: 'authenticated' }
  if (result.requiresOpenaiAuth === true && account === undefined) return { status: 'unauthenticated' }

  return { status: 'unknown' }
}

function isAuthenticatedCodexAccount(
  result: Record<string, unknown>,
  account: Record<string, unknown> | undefined,
): boolean {
  const email = result.email
  return (
    (typeof email === 'string' && email.length > 0) ||
    result.type === 'chatgpt' ||
    result.type === 'apiKey' ||
    account?.type === 'chatgpt' ||
    account?.type === 'apiKey'
  )
}

function handleCodexInitializeResponse(
  parsed: Record<string, unknown>,
  accountId: number,
  writeMessage: (message: unknown) => void,
  reject: (error: Error) => void,
): void {
  if (parsed.error !== undefined) {
    reject(new Error(`Codex initialize failed: ${getRpcErrorMessage(parsed.error)}`))
    return
  }

  writeMessage({ method: 'initialized' })
  writeMessage({ id: accountId, method: 'account/read', params: {} })
}

function handleCodexAccountResponse(
  parsed: Record<string, unknown>,
  resolve: (auth: CLIProbeResult['auth']) => void,
): void {
  if (parsed.error !== undefined) {
    resolve(authStatusFromCodexError(parsed.error))
    return
  }

  resolve(authStatusFromCodexAccount(getUnknownRecord(parsed.result)))
}

interface ProbeLifecycleState {
  completed: boolean
}

function createProbeCleanup(
  timeout: NodeJS.Timeout,
  output: readline.Interface,
  child: ChildProcess,
) {
  return () => {
    clearTimeout(timeout)
    output.removeAllListeners()
    output.close()
    child.removeAllListeners()
    if (!child.killed) {
      killProcessTree(child)
    }
  }
}

function createProbeSettlers<Result>(
  state: ProbeLifecycleState,
  cleanup: () => void,
  resolve: (value: Result) => void,
  reject: (error: Error) => void,
) {
  return {
    resolveProbe: (value: Result) => {
      state.completed = true
      cleanup()
      resolve(value)
    },
    rejectProbe: (error: Error) => {
      state.completed = true
      cleanup()
      reject(error)
    },
  }
}

function createVoidProbeSettlers(
  state: ProbeLifecycleState,
  cleanup: () => void,
  resolve: () => void,
  reject: (error: Error) => void,
) {
  return {
    resolveProbe: () => {
      state.completed = true
      cleanup()
      resolve()
    },
    rejectProbe: (error: Error) => {
      state.completed = true
      cleanup()
      reject(error)
    },
  }
}

function probeCursorAcp(binaryPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: createCodingAgentsProcessEnv(process.env),
    })

    const output = readline.createInterface({ input: child.stdout })
    const probeState: ProbeLifecycleState = { completed: false }

    const timeout = setTimeout(() => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(new Error('Cursor ACP probe timed out'))
      }
    }, CURSOR_ACP_PROBE_TIMEOUT_MS)

    const cleanup = createProbeCleanup(timeout, output, child)
    const { resolveProbe, rejectProbe } = createVoidProbeSettlers(
      probeState,
      cleanup,
      resolve,
      reject,
    )

    output.on('line', (line) => {
      const parsed = parseProbeLine(line)
      if (parsed === undefined) return

      if (parsed.id === 1) {
        handleCursorInitializeResponse(parsed, resolveProbe, rejectProbe)
      }
    })

    child.once('error', (err) => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(err)
      }
    })

    child.once('exit', (code, signal) => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(new Error(childExitMessage('cursor-agent acp', code, signal)))
      }
    })

    if (!child.stdin.writable) {
      probeState.completed = true
      cleanup()
      reject(new Error('Cursor ACP stdin closed before initialize'))
      return
    }

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'bitsentry_desktop',
          title: 'BitSentry SuperTerminal',
          version: '0.1.0',
        },
      },
    })}\n`)
  })
}

function probeCodexAccount(
  binaryPath: string,
  extraArgs?: string[],
): Promise<CLIProbeResult['auth']> {
  return new Promise((resolve, reject) => {
    const spawnArgs = [...(extraArgs ?? []), 'app-server']
    const commandEnv = createCodingAgentsProcessEnv(process.env)
    let invocation = { command: binaryPath, args: spawnArgs }
    if (process.platform === 'win32' && isWindowsCmdShim(binaryPath)) {
      invocation = createWindowsCmdInvocation(binaryPath, spawnArgs, commandEnv)
    }
    const child = spawn(invocation.command, invocation.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: commandEnv,
    })

    const output = readline.createInterface({ input: child.stdout })
    const probeState: ProbeLifecycleState = { completed: false }
    let nextId = 1

    const timeout = setTimeout(() => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(new Error('Codex app-server probe timed out'))
      }
    }, CODEX_PROBE_TIMEOUT_MS)

    const cleanup = createProbeCleanup(timeout, output, child)

    const writeMessage = (msg: unknown) => {
      if (child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(msg)}\n`)
      }
    }

    const { resolveProbe, rejectProbe } = createProbeSettlers(
      probeState,
      cleanup,
      resolve,
      reject,
    )

    const initId = nextId++
    const accountId = nextId++

    output.on('line', (line) => {
      const parsed = parseProbeLine(line)
      if (parsed === undefined) return

      if (parsed.id === initId) {
        handleCodexInitializeResponse(parsed, accountId, writeMessage, rejectProbe)
        return
      }

      if (parsed.id === accountId) {
        handleCodexAccountResponse(parsed, resolveProbe)
      }
    })

    child.once('error', (err) => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(err)
      }
    })

    child.once('exit', (code, signal) => {
      if (!probeState.completed) {
        probeState.completed = true
        cleanup()
        reject(new Error(childExitMessage('codex app-server', code, signal)))
      }
    })

    writeMessage({
      id: initId,
      method: 'initialize',
      params: {
        clientInfo: { name: 'bitsentry_desktop', title: 'BitSentry SuperTerminal', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })
  })
}

export async function detectBinary(
  provider: ProbeProvider,
  preferredBinaryPath?: string,
): Promise<string | null> {
  return resolveProviderBinaryPath(provider, preferredBinaryPath)
}

export interface DoctorResult {
  provider: ProbeProvider
  binaryPath: string
  probe: CLIProbeResult
  resolvedPath?: string
  stderrTail?: string
}

const PROVIDER_PROBES = {
  claude_code: probeClaudeCode,
  codex: probeCodex,
  opencode: probeOpenCode,
  cursor: probeCursor,
} satisfies Record<
  ProbeProvider,
  (binaryPath: string, args?: string[]) => Promise<CLIProbeResult>
>

export async function doctor(
  provider: ProbeProvider,
  binaryPath: string,
  args?: string[],
): Promise<DoctorResult> {
  const resolved = await detectBinary(provider, binaryPath)
  const probe = await PROVIDER_PROBES[provider](binaryPath, args)

  let stderrTail: string | undefined
  if (!probe.installed || probe.status === 'error') {
    try {
      const result = await runCommand(resolved ?? binaryPath, ['--version'], PROBE_TIMEOUT_MS)
      const trimmedTail = result.stderr.trim().slice(-500)
      if (trimmedTail !== '') {
        stderrTail = trimmedTail
      }
    } catch {
      // already captured in probe
    }
  }

  return {
    provider,
    binaryPath,
    probe,
    resolvedPath: resolved ?? undefined,
    stderrTail,
  }
}
