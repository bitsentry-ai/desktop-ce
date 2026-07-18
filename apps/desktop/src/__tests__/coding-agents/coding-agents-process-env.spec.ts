import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { createCodingAgentsProcessEnv } from '@bitsentry-ce/coding-agents/coding-agents-process-env'

describe('createCodingAgentsProcessEnv', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('prepends the installed nvm Node 22 bin directory to PATH', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-local-ai-env-'))
    tempDirs.push(tempHome)

    const nvmDir = path.join(tempHome, '.nvm')
    const node20Bin = path.join(nvmDir, 'versions', 'node', 'v20.20.0', 'bin')
    const node22Bin = path.join(nvmDir, 'versions', 'node', 'v22.14.0', 'bin')
    await mkdir(path.join(nvmDir, 'alias'), { recursive: true })
    await mkdir(node20Bin, { recursive: true })
    await mkdir(node22Bin, { recursive: true })
    await writeFile(path.join(nvmDir, 'alias', 'default'), '22.14.0\n')

    const env = createCodingAgentsProcessEnv({
      HOME: tempHome,
      NVM_DIR: nvmDir,
      PATH: ['/usr/bin', node20Bin].join(path.delimiter),
    })

    const pathEntries = String(env.PATH).split(path.delimiter)
    expect(pathEntries[0]).toBe(node22Bin)
    expect(pathEntries).toContain('/usr/bin')
    expect(pathEntries).toContain(node20Bin)
  })

  it('preserves case-insensitive Windows path variables when prepending Node 22', async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-local-ai-env-'))
    tempDirs.push(tempHome)

    const nvmDir = path.join(tempHome, '.nvm')
    const node20Bin = path.join(nvmDir, 'versions', 'node', 'v20.20.0', 'bin')
    const node22Bin = path.join(nvmDir, 'versions', 'node', 'v22.14.0', 'bin')
    const existingEntry = '/windows/system32'
    await mkdir(path.join(nvmDir, 'alias'), { recursive: true })
    await mkdir(node20Bin, { recursive: true })
    await mkdir(node22Bin, { recursive: true })
    await writeFile(path.join(nvmDir, 'alias', 'default'), '22.14.0\n')

    const env = createCodingAgentsProcessEnv({
      HOME: tempHome,
      NVM_DIR: nvmDir,
      Path: [existingEntry, node20Bin].join(path.delimiter),
    })

    const pathEntries = String(env.Path).split(path.delimiter)
    expect(pathEntries[0]).toBe(node22Bin)
    expect(pathEntries).toContain(existingEntry)
    expect(pathEntries).toContain(node20Bin)
    expect(env.PATH).toBeUndefined()
  })

  it('forwards only the environment needed to locate and run the local CLI', () => {
    const env = createCodingAgentsProcessEnv({
      HOME: '/tmp/bitsentry-home',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'must-not-reach-child-process',
      GITHUB_TOKEN: 'must-not-reach-child-process',
      DATABASE_URL: 'must-not-reach-child-process',
    })

    expect(env).toMatchObject({
      HOME: '/tmp/bitsentry-home',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
    })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })
})
