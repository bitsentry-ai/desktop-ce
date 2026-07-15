import { existsSync, readFileSync, readdirSync } from 'fs'
import path from 'path'

const PREFERRED_NODE_MAJOR = 22

const SAFE_CODING_AGENT_ENVIRONMENT_KEY = /^(HOME|USER|LOGNAME|SHELL|PATH|NVM_DIR|LANG|TERM|COLORTERM|TMP|TEMP|TMPDIR|XDG_(CONFIG|CACHE|DATA)_HOME|APPDATA|LOCALAPPDATA|PROGRAMDATA|SYSTEMROOT|COMSPEC|WINDIR)$/i

function createSafeCodingAgentEnvironment(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (SAFE_CODING_AGENT_ENVIRONMENT_KEY.test(key)) {
      env[key] = value
    }
  }
  return env
}

function parseVersionPart(part: string): number {
  const parsed = Number.parseInt(part, 10)
  if (Number.isNaN(parsed)) {
    return 0
  }

  return parsed
}

function normalizeParsedVersionPart(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return 0
  }

  return value
}

function parseNodeMajor(version: string): number | null {
  const match = version.trim().match(/^v?(\d+)\./)
  if (match === null) return null
  return Number.parseInt(match[1], 10)
}

function compareNodeVersions(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(parseVersionPart)
  const rightParts = right.replace(/^v/, '').split('.').map(parseVersionPart)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    const leftNumber = normalizeParsedVersionPart(leftPart)
    const rightNumber = normalizeParsedVersionPart(rightPart)
    const diff = leftNumber - rightNumber
    if (diff !== 0) return diff
  }

  return 0
}

function resolveNvmDir(baseEnv: NodeJS.ProcessEnv): string | undefined {
  let nvmDir = baseEnv.NVM_DIR?.trim()
  if ((nvmDir === undefined || nvmDir === '') && baseEnv.HOME !== undefined && baseEnv.HOME !== '') {
    nvmDir = path.join(baseEnv.HOME, '.nvm')
  }

  if (nvmDir === undefined || nvmDir === '') {
    return undefined
  }

  return nvmDir
}

function resolveAliasNode22BinDir(nvmDir: string, versionsDir: string): string | undefined {
  const aliasDefaultPath = path.join(nvmDir, 'alias', 'default')
  if (!existsSync(aliasDefaultPath)) {
    return undefined
  }

  const aliasVersion = readFileSync(aliasDefaultPath, 'utf8').trim()
  const aliasMajor = parseNodeMajor(aliasVersion)
  if (aliasMajor !== PREFERRED_NODE_MAJOR) {
    return undefined
  }

  let versionDir = aliasVersion
  if (!aliasVersion.startsWith('v')) {
    versionDir = `v${aliasVersion}`
  }

  const aliasBinDir = path.join(versionsDir, versionDir, 'bin')
  if (existsSync(aliasBinDir)) {
    return aliasBinDir
  }

  return undefined
}

function resolveLatestNode22BinDir(versionsDir: string): string | undefined {
  const candidates = readdirSync(versionsDir)
    .filter((entry) => parseNodeMajor(entry) === PREFERRED_NODE_MAJOR)
    .sort(compareNodeVersions)

  const latest = candidates.at(-1)
  if (latest === undefined) return undefined

  const binDir = path.join(versionsDir, latest, 'bin')
  if (existsSync(binDir)) {
    return binDir
  }

  return undefined
}

function resolvePreferredNode22BinDir(baseEnv: NodeJS.ProcessEnv): string | undefined {
  const nvmDir = resolveNvmDir(baseEnv)
  if (nvmDir === undefined) return undefined

  const versionsDir = path.join(nvmDir, 'versions', 'node')
  if (!existsSync(versionsDir)) return undefined

  const aliasBinDir = resolveAliasNode22BinDir(nvmDir, versionsDir)
  if (aliasBinDir !== undefined) {
    return aliasBinDir
  }

  return resolveLatestNode22BinDir(versionsDir)
}

function getPathVariableKeys(baseEnv: NodeJS.ProcessEnv): string[] {
  return Object.keys(baseEnv).filter((key) => key.toLowerCase() === 'path')
}

export function createCodingAgentsProcessEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = createSafeCodingAgentEnvironment(baseEnv)
  const preferredNode22BinDir = resolvePreferredNode22BinDir(baseEnv)
  if (preferredNode22BinDir === undefined || preferredNode22BinDir === '') {
    return env
  }

  const pathVariableKeys = getPathVariableKeys(baseEnv)
  const currentPathValue = pathVariableKeys
    .map((key) => baseEnv[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0)

  const pathEntries = (currentPathValue ?? '')
    .split(path.delimiter)
    .filter((entry) => entry !== '')
    .filter((entry) => entry !== preferredNode22BinDir)

  const nextPathValue = [preferredNode22BinDir, ...pathEntries].join(path.delimiter)

  if (pathVariableKeys.length === 0) {
    env.PATH = nextPathValue
    return env
  }

  for (const key of pathVariableKeys) {
    env[key] = nextPathValue
  }

  return env
}
