import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  execFile: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  readdir: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock('electron-log', () => ({
  default: mocks.log,
}))

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}))

vi.mock('fs/promises', () => ({
  access: mocks.access,
  constants: { X_OK: 1 },
  readdir: mocks.readdir,
}))

type ExecFileResult = {
  stdout?: string
  stderr?: string
  exitCode?: number | null
  error?: Error & {
    code?: string | number
    killed?: boolean
  }
}

type ExecFileHandler = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => ExecFileResult

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}

function restorePlatform(): void {
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  }
}

function createExecError(code: string | number): Error & { code: string | number } {
  const error = new Error(String(code)) as Error & { code: string | number }
  error.code = code
  return error
}

function mockExecFile(handler: ExecFileHandler): void {
  mocks.execFile.mockImplementation((
    command: string,
    args: string[],
    options: Record<string, unknown>,
    callback: (error: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    const result = handler(command, [...args], options)
    let exitCode: number | null = result.exitCode ?? 0
    if (result.error !== undefined) {
      exitCode = null
      if (typeof result.error.code === 'number') {
        exitCode = result.error.code
      }
    }
    const child = {
      exitCode,
      killed: false,
      kill: vi.fn(),
      pid: 1234,
    }

    queueMicrotask(() => {
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
    })

    return child
  })
}

function getWindowsCommandLine(args: string[]): string {
  return args.at(-1) ?? ''
}

describe('cli-probe service', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.access.mockReset()
    mocks.execFile.mockReset()
    mocks.log.info.mockReset()
    mocks.log.warn.mockReset()
    mocks.log.error.mockReset()
    mocks.readdir.mockReset()
    mocks.readdir.mockResolvedValue([])
    mocks.spawn.mockReset()
    mocks.spawnSync.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    restorePlatform()
  })

  it('prefers the Windows npm claude.cmd shim when where returns extensionless and .cmd paths', async () => {
    // Arrange
    stubPlatform('win32')
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return {
          stdout: [
            'C:\\Users\\User\\AppData\\Roaming\\npm\\claude',
            'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd',
          ].join('\r\n'),
        }
      }

      if (command === 'cmd.exe') {
        const commandLine = getWindowsCommandLine(args)
        if (commandLine.includes('C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd') && commandLine.includes('--version')) {
          return { stdout: '2.1.150 (Claude Code)\n' }
        }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const {
      detectBinary,
      setCodingAgentsLoggerForTesting,
    } = await import('@bitsentry-ce/coding-agents/cli-probe.service')
    setCodingAgentsLoggerForTesting(mocks.log)

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBe('C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd')
    expect(mocks.execFile.mock.calls.some(([command, args]) => {
      return command === 'cmd.exe'
        && getWindowsCommandLine(args as string[]).includes('claude.cmd')
    })).toBe(true)
  })

  it('preserves Windows PATH precedence when where returns an earlier .exe and later .cmd', async () => {
    // Arrange
    stubPlatform('win32')
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return {
          stdout: [
            'C:\\Tools\\claude.exe',
            'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd',
          ].join('\r\n'),
        }
      }

      if (command === 'C:\\Tools\\claude.exe' && args[0] === '--version') {
        return { stdout: '2.2.0 (Claude Code)\n' }
      }

      if (command === 'cmd.exe') {
        const commandLine = getWindowsCommandLine(args)
        if (commandLine.includes('C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd') && commandLine.includes('--version')) {
          return { stdout: '2.1.150 (Claude Code)\n' }
        }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const {
      detectBinary,
      setCodingAgentsLoggerForTesting,
    } = await import('@bitsentry-ce/coding-agents/cli-probe.service')
    setCodingAgentsLoggerForTesting(mocks.log)

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBe('C:\\Tools\\claude.exe')
  })

  it('probes Claude through claude.cmd and reports the installed version', async () => {
    // Arrange
    stubPlatform('win32')
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return {
          stdout: [
            'C:\\Users\\User\\AppData\\Roaming\\npm\\claude',
            'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd',
          ].join('\n'),
        }
      }

      if (command === 'cmd.exe') {
        const commandLine = getWindowsCommandLine(args)
        if (!commandLine.includes('C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd')) {
          throw new Error(`Unexpected Windows command line: ${commandLine}`)
        }
        if (commandLine.includes('--version')) {
          return { stdout: '2.1.150 (Claude Code)\n' }
        }
        if (commandLine.includes('auth') && commandLine.includes('status')) {
          return { stdout: '{"authenticated":true}\n' }
        }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { probeClaudeCode } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await probeClaudeCode('claude')

    // Assert
    expect(result.installed).toBe(true)
    expect(result.version).toBe('2.1.150')
    expect(result.auth.status).toBe('authenticated')
    expect(result.status).toBe('ready')
  })

  it('falls back to the Windows npm global directory when where claude fails', async () => {
    // Arrange
    stubPlatform('win32')
    vi.stubEnv('APPDATA', 'C:\\Users\\User\\AppData\\Roaming')

    const fallback = 'C:\\Users\\User\\AppData\\Roaming\\npm\\claude.cmd'
    mocks.access.mockImplementation((candidate: string) => {
      if (candidate === fallback) return Promise.resolve()
      return Promise.reject(new Error(`Missing fixture path: ${candidate}`))
    })
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return { error: createExecError(1), exitCode: 1 }
      }

      if (command === 'cmd.exe') {
        const commandLine = getWindowsCommandLine(args)
        if (commandLine.includes(fallback) && commandLine.includes('--version')) {
          return { stdout: '2.1.150 (Claude Code)\n' }
        }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBe(fallback)
    expect(mocks.access).toHaveBeenCalledWith(fallback, expect.any(Number))
  })

  it('finds Codex under the Windows LOCALAPPDATA Programs install path', async () => {
    // Arrange
    stubPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\User\\AppData\\Local')

    const codexPath = 'C:\\Users\\User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
    mocks.access.mockImplementation((candidate: string) => {
      if (candidate === codexPath) return Promise.resolve()
      return Promise.reject(new Error(`Missing fixture path: ${candidate}`))
    })
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'codex') {
        return { error: createExecError(1), exitCode: 1 }
      }
      if (command === codexPath && args[0] === '--version') {
        return { stdout: 'codex-cli 0.135.0\n' }
      }
      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('codex', 'codex')

    // Assert
    expect(result).toBe(codexPath)
  })

  it('finds Claude Code under a WinGet package directory', async () => {
    // Arrange
    stubPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\User\\AppData\\Local')

    const root = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages'
    const claudePath = `${root}\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`
    mocks.readdir.mockImplementation((dir: string) => {
      if (dir === root) {
        return Promise.resolve([
          { name: 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', isDirectory: () => true },
          { name: 'SST.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe', isDirectory: () => true },
        ])
      }
      return Promise.resolve([])
    })
    mocks.access.mockImplementation((candidate: string) => {
      if (candidate === claudePath) return Promise.resolve()
      return Promise.reject(new Error(`Missing fixture path: ${candidate}`))
    })
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return { error: createExecError(1), exitCode: 1 }
      }
      if (command === claudePath && args[0] === '--version') {
        return { stdout: '2.1.158 (Claude Code)\n' }
      }
      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBe(claudePath)
  })

  it('finds opencode under a WinGet package directory', async () => {
    // Arrange
    stubPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\User\\AppData\\Local')

    const root = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages'
    const openCodePath = `${root}\\SST.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe\\opencode.exe`
    mocks.readdir.mockImplementation((dir: string) => {
      if (dir === root) {
        return Promise.resolve([
          { name: 'SST.opencode_Microsoft.Winget.Source_8wekyb3d8bbwe', isDirectory: () => true },
        ])
      }
      return Promise.resolve([])
    })
    mocks.access.mockImplementation((candidate: string) => {
      if (candidate === openCodePath) return Promise.resolve()
      return Promise.reject(new Error(`Missing fixture path: ${candidate}`))
    })
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'opencode') {
        return { error: createExecError(1), exitCode: 1 }
      }
      if (command === openCodePath && args[0] === '--version') {
        return { stdout: '1.17.3\n' }
      }
      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('opencode', 'opencode')

    // Assert
    expect(result).toBe(openCodePath)
  })

  it('uses the user WindowsApps Codex alias when package enumeration is inaccessible', async () => {
    // Arrange
    stubPlatform('win32')
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\User\\AppData\\Local')

    const aliasPath = 'C:\\Users\\User\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe'
    const error = createExecError('EACCES')
    mocks.readdir.mockImplementation((dir: string) => {
      if (dir === 'C:\\Program Files\\WindowsApps') return Promise.reject(error)
      return Promise.resolve([])
    })
    mocks.access.mockImplementation((candidate: string) => {
      if (candidate === aliasPath) return Promise.resolve()
      return Promise.reject(new Error(`Missing fixture path: ${candidate}`))
    })
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'codex') {
        return { error: createExecError(1), exitCode: 1 }
      }
      if (command === aliasPath && args[0] === '--version') {
        return { stdout: 'codex-cli 0.135.0\n' }
      }
      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('codex', 'codex')

    // Assert
    expect(result).toBe(aliasPath)
    expect(mocks.log.info).toHaveBeenCalledWith(
      '[local-ai] Skipping Windows CLI directory scan',
      expect.objectContaining({ root: 'C:\\Program Files\\WindowsApps', code: 'EACCES' }),
    )
  })

  it('logs the resolved command and real stderr when a candidate probe fails', async () => {
    // Arrange
    stubPlatform('win32')
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'claude') {
        return { stdout: 'C:\\Broken\\claude.exe\n' }
      }
      if (command === 'C:\\Broken\\claude.exe' && args[0] === '--version') {
        return {
          error: createExecError(2),
          exitCode: 2,
          stderr: 'bad install',
        }
      }
      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBeNull()
    expect(mocks.log.warn).toHaveBeenCalledWith(
      '[local-ai] coding agent detection candidate failed',
      expect.objectContaining({
        provider: 'claude_code',
        candidate: 'claude',
        resolvedCommand: 'C:\\Broken\\claude.exe',
        args: ['--version'],
        exitCode: 2,
        stderr: 'bad install',
      }),
    )
  })

  it('keeps non-Windows detection on which and direct execFile', async () => {
    // Arrange
    stubPlatform('linux')
    mockExecFile((command, args) => {
      if (command === 'which' && args[0] === 'claude') {
        return { stdout: '/usr/local/bin/claude\n' }
      }

      if (command === '/usr/local/bin/claude' && args[0] === '--version') {
        return { stdout: '2.1.150 (Claude Code)\n' }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('claude_code', 'claude')

    // Assert
    expect(result).toBe('/usr/local/bin/claude')
    expect(mocks.execFile.mock.calls.some(([command]) => command === 'cmd.exe')).toBe(false)
  })

  it('uses Cursor about to detect a logged-out CLI after status reports authenticated', async () => {
    // Arrange
    stubPlatform('linux')
    mockExecFile((command, args) => {
      if (command === 'which' && args[0] === 'cursor-agent') {
        return { stdout: '/usr/local/bin/cursor-agent\n' }
      }

      if (command === '/usr/local/bin/cursor-agent' && args[0] === '--version') {
        return { stdout: '2026.07.01\n' }
      }

      if (command === '/usr/local/bin/cursor-agent' && args[0] === 'status') {
        return { stdout: 'Logged in as wira@example.com\n' }
      }

      if (command === '/usr/local/bin/cursor-agent' && args[0] === 'about') {
        return { stdout: 'User Email          Not logged in\n' }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { probeCursor } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await probeCursor('cursor-agent')

    // Assert
    expect(result.auth).toEqual({ status: 'unauthenticated' })
    expect(result.status).toBe('error')
    expect(result.errorKind).toBe('unauthenticated')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not invoke Cursor about after status reports unauthenticated', async () => {
    // Arrange
    stubPlatform('linux')
    mockExecFile((command, args) => {
      if (command === 'which' && args[0] === 'cursor-agent') {
        return { stdout: '/usr/local/bin/cursor-agent\n' }
      }

      if (command === '/usr/local/bin/cursor-agent' && args[0] === '--version') {
        return { stdout: '2026.07.01\n' }
      }

      if (command === '/usr/local/bin/cursor-agent' && args[0] === 'status') {
        return { stdout: 'Not logged in\n' }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { probeCursor } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await probeCursor('cursor-agent')

    // Assert
    expect(result.auth).toEqual({ status: 'unauthenticated' })
    expect(result.status).toBe('error')
    expect(result.errorKind).toBe('unauthenticated')
    expect(mocks.execFile.mock.calls.some(([, args]) => args[0] === 'about')).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not rewrite Windows Codex .exe detection into a command shim', async () => {
    // Arrange
    stubPlatform('win32')
    mockExecFile((command, args) => {
      if (command === 'where' && args[0] === 'codex') {
        return { stdout: 'C:\\Tools\\codex.exe\n' }
      }

      if (command === 'C:\\Tools\\codex.exe' && args[0] === '--version') {
        return { stdout: 'codex 0.63.0\n' }
      }

      throw new Error(`Unexpected execFile call: ${command} ${JSON.stringify(args)}`)
    })

    const { detectBinary } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

    // Act
    const result = await detectBinary('codex', 'codex')

    // Assert
    expect(result).toBe('C:\\Tools\\codex.exe')
    expect(mocks.execFile.mock.calls.some(([command]) => command === 'cmd.exe')).toBe(false)
  })
})
