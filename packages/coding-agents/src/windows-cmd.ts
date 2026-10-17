import path from 'path'

const WINDOWS_CMD_SHIM_EXTENSIONS = new Set(['.cmd', '.bat'])

export function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = env[name]
  if (exact !== undefined) return exact

  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase())
  if (match === undefined) {
    return undefined
  }

  return env[match]
}

export function isWindowsCmdShim(binaryPath: string): boolean {
  return WINDOWS_CMD_SHIM_EXTENSIONS.has(path.win32.extname(binaryPath).toLowerCase())
}

export function quoteWindowsCmdArgument(value: string): string {
  if (value.length === 0) return '""'
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`
}

export function buildWindowsCmdCommandLine(command: string, args: string[]): string {
  const commandLine = [command, ...args].map(quoteWindowsCmdArgument).join(' ')
  return `"${commandLine}"`
}

export function getWindowsCmdExecutable(env: NodeJS.ProcessEnv): string {
  return getEnvValue(env, 'ComSpec') ?? getEnvValue(env, 'COMSPEC') ?? 'cmd.exe'
}
