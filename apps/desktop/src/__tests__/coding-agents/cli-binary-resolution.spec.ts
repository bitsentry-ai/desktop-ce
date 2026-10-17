import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createCommandInvocation,
  resolveOpenCodeWindowsBinary,
} from '@bitsentry-ce/coding-agents/cli-binary-resolution'

describe('cli binary resolution', () => {
  const tempDirs: string[] = []
  const originalAppData = process.env.APPDATA

  afterEach(async () => {
    if (originalAppData === undefined) {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = originalAppData
    }
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('wraps Windows command shims through one escaped cmd.exe command line', () => {
    const invocation = createCommandInvocation(
      'opencode.cmd',
      ['run', 'prompt with & | < > ( ) %USERPROFILE% !PATH! "quotes"'],
      'win32',
    )

    expect(invocation).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '"opencode.cmd" "run" "prompt with ^& ^| ^< ^> ^( ^) ^%USERPROFILE^% ^!PATH^! ^"quotes^""',
      ],
    })
  })

  it('leaves non-Windows command invocations unwrapped', () => {
    expect(createCommandInvocation('opencode.cmd', ['--version'], 'darwin')).toEqual({
      command: 'opencode.cmd',
      args: ['--version'],
    })
  })

  it.skipIf(process.platform !== 'win32')('resolves OpenCode from AppData root, npm shim, and command name on Windows', async () => {
    const appData = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-opencode-appdata-'))
    tempDirs.push(appData)
    process.env.APPDATA = appData

    const npmDir = path.join(appData, 'npm')
    const exePath = path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe')
    const shimPath = path.join(npmDir, 'opencode.cmd')
    await mkdir(path.dirname(exePath), { recursive: true })
    await writeFile(exePath, '')
    await writeFile(shimPath, '@echo off\r\n')

    expect(resolveOpenCodeWindowsBinary(appData)).toBe(exePath)
    expect(resolveOpenCodeWindowsBinary(npmDir)).toBe(exePath)
    expect(resolveOpenCodeWindowsBinary(shimPath)).toBe(exePath)
    expect(resolveOpenCodeWindowsBinary('opencode')).toBe(exePath)
  })
})
