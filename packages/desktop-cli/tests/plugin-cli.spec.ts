import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

import {
  runRunbooksCli,
  type RunbookCliRuntimeFactory,
} from '../src/cli/runbooks-cli'
import { afterEach, describe, expect, it, vi } from 'vitest'

const unusedRunbookRuntimeFactory: RunbookCliRuntimeFactory = () =>
  Promise.reject(new Error('Plugin commands must not create the runbook runtime'))

describe('plugin CLI lifecycle', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await Promise.all(
      tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    )
    tempRoots.length = 0
  })

  async function writePluginArtifact(input: {
    tempRoot: string
    pluginId: string
  }): Promise<string> {
    const artifactPath = path.join(input.tempRoot, `${input.pluginId}.plugin.js`)
    await writeFile(
      artifactPath,
      `
exports.plugin = {
  id: '${input.pluginId}',
  name: 'CLI Plugin Test',
  version: '1.0.0',
  description: 'A downloadable BitSentry code plugin exercised through the CLI.',
  auth: {
    fields: [
      { key: 'token', label: 'Token', type: 'string', required: false, secret: true },
    ],
  },
  actions: [
    {
      id: 'ping',
      title: 'Ping',
      description: 'Confirms the CLI can execute installed plugin-owned code.',
      riskLevel: 'read',
      fields: [
        { key: 'name', label: 'Name', type: 'string', required: true },
      ],
      execute(context) {
        return {
          ok: true,
          status: 200,
          summary: 'pong for ' + context.input.name,
          data: {
            pluginRoot: context.host.pluginRoot,
            token: context.auth.token ?? null,
          },
        }
      },
    },
  ],
}
`,
    )

    return artifactPath
  }

  async function writePluginIndex(input: {
    tempRoot: string
    pluginName: string
    artifactPath: string
  }): Promise<string> {
    const indexPath = path.join(input.tempRoot, 'index.yaml')
    await writeFile(
      indexPath,
      [
        'plugins:',
        `  ${input.pluginName}:`,
        '    description: Test plugin from a first-party index.',
        `    artifactUrl: ${JSON.stringify(path.basename(input.artifactPath))}`,
        '',
      ].join('\n'),
    )

    return indexPath
  }

  async function runPluginCli(args: string[]): Promise<string> {
    const chunks: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      let chunkText = String(chunk)
      if (Buffer.isBuffer(chunk)) {
        chunkText = chunk.toString('utf-8')
      }
      chunks.push(chunkText)
      return true
    })

    try {
      await runRunbooksCli(unusedRunbookRuntimeFactory, [
        'node',
        'bitsentry',
        ...args,
      ])
      return chunks.join('')
    } finally {
      write.mockRestore()
    }
  }

  function parseJson(output: string): unknown {
    return JSON.parse(output) as unknown
  }

  it('installs, lists, configures, executes, updates, and removes an indexed single-file plugin', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-cli-'))
    tempRoots.push(tempRoot)

    const artifactPath = await writePluginArtifact({
      tempRoot,
      pluginId: 'cli-plugin-test',
    })
    const indexPath = await writePluginIndex({
      tempRoot,
      pluginName: 'cli-plugin-test',
      artifactPath,
    })
    const indexUrl = pathToFileURL(indexPath).toString()
    const pluginDirectory = path.join(tempRoot, 'plugins')

    const installOutput = await runPluginCli([
      'plugin',
      'install',
      'cli-plugin-test',
      '--index-url',
      indexUrl,
      '--plugin-dir',
      pluginDirectory,
      '--json',
    ])
    const installResult = parseJson(installOutput) as {
      pluginId: string
      installedPath: string
      descriptor: { id: string; actions: Array<{ id: string }> }
      artifactUrl: string
    }

    expect(installResult.pluginId).toBe('cli-plugin-test')
    expect(installResult.installedPath).toBe(path.join(pluginDirectory, 'cli-plugin-test'))
    expect(installResult.artifactUrl).toBe(path.resolve(tempRoot, path.basename(artifactPath)))
    expect(installResult.descriptor.actions).toEqual([
      expect.objectContaining({ id: 'ping' }),
    ])

    const listOutput = await runPluginCli([
      'plugin',
      'list',
      '--plugin-dir',
      pluginDirectory,
      '--json',
    ])
    const listResult = parseJson(listOutput) as Array<{ id: string }>
    expect(listResult).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cli-plugin-test' })]),
    )

    const infoOutput = await runPluginCli([
      'plugin',
      'info',
      'cli-plugin-test',
      '--plugin-dir',
      pluginDirectory,
      '--json',
    ])
    const infoResult = parseJson(infoOutput) as { id: string; name: string }
    expect(infoResult).toMatchObject({
      id: 'cli-plugin-test',
      name: 'CLI Plugin Test',
    })

    const configureOutput = await runPluginCli([
      'plugin',
      'configure',
      'cli-plugin-test',
      '--plugin-dir',
      pluginDirectory,
      '--user-data-dir',
      tempRoot,
      '--auth-json',
      '{"token":"abc123"}',
      '--json',
    ])
    expect(parseJson(configureOutput)).toEqual({
      pluginId: 'cli-plugin-test',
      updatedKeys: ['token'],
    })

    const showConfigOutput = await runPluginCli([
      'plugin',
      'show-config',
      'cli-plugin-test',
      '--plugin-dir',
      pluginDirectory,
      '--user-data-dir',
      tempRoot,
      '--json',
    ])
    expect(parseJson(showConfigOutput)).toEqual({
      pluginId: 'cli-plugin-test',
      values: {
        token: '********',
      },
    })

    const executeOutput = await runPluginCli([
      'plugin',
      'execute',
      '--plugin-id',
      'cli-plugin-test',
      '--action-id',
      'ping',
      '--plugin-dir',
      pluginDirectory,
      '--user-data-dir',
      tempRoot,
      '--input-json',
      '{"name":"Theo"}',
      '--json',
    ])
    expect(parseJson(executeOutput)).toMatchObject({
      ok: true,
      status: 200,
      summary: 'pong for Theo',
      data: {
        pluginRoot: path.join(pluginDirectory, 'cli-plugin-test'),
        token: 'abc123',
      },
    })

    const updateOutput = await runPluginCli([
      'plugin',
      'update',
      'cli-plugin-test',
      '--index-url',
      indexUrl,
      '--plugin-dir',
      pluginDirectory,
      '--json',
    ])
    expect(parseJson(updateOutput)).toMatchObject({
      pluginId: 'cli-plugin-test',
      descriptor: {
        id: 'cli-plugin-test',
      },
    })

    const removeOutput = await runPluginCli([
      'plugin',
      'remove',
      'cli-plugin-test',
      '--plugin-dir',
      pluginDirectory,
      '--user-data-dir',
      tempRoot,
      '--json',
    ])
    expect(parseJson(removeOutput)).toEqual({
      pluginId: 'cli-plugin-test',
      removed: true,
    })
  })

  it('rejects indexes that include versioning fields', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-cli-'))
    tempRoots.push(tempRoot)

    const indexPath = path.join(tempRoot, 'index.yaml')
    await writeFile(
      indexPath,
      [
        'plugins:',
        '  github:',
        '    version: 1.0.0',
        '    artifactUrl: github.plugin.js',
        '',
      ].join('\n'),
    )

    await expect(
      runPluginCli([
        'plugin',
        'install',
        'github',
        '--index-url',
        pathToFileURL(indexPath).toString(),
        '--plugin-dir',
        path.join(tempRoot, 'plugins'),
        '--json',
      ]),
    ).rejects.toThrow('version')
  })

  it('installs one plugin from an HTTPS first-party index without bundling implementations', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-cli-'))
    tempRoots.push(tempRoot)

    const artifactPath = await writePluginArtifact({
      tempRoot,
      pluginId: 'remote-index-plugin-test',
    })
    const artifact = await readFile(artifactPath)
    const indexUrl = 'https://plugins.bitsentry.ai/index.yaml'
    const artifactUrl = 'https://plugins.bitsentry.ai/remote-index-plugin-test.plugin.js'
    const fetchMock = vi.fn((input: string | URL | Request) => {
      let url: string
      if (typeof input === 'string') {
        url = input
      } else if (input instanceof URL) {
        url = input.toString()
      } else {
        url = input.url
      }
      if (url === indexUrl) {
        return new Response(
          [
            'plugins:',
            '  remote-index-plugin-test:',
            '    description: Test plugin from the remote first-party index.',
            '    artifactUrl: ./remote-index-plugin-test.plugin.js',
            '',
          ].join('\n'),
          { status: 200 },
        )
      }

      if (url === artifactUrl) {
        return new Response(artifact, { status: 200 })
      }

      return new Response('not found', { status: 404, statusText: 'Not Found' })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pluginDirectory = path.join(tempRoot, 'plugins')
    const installOutput = await runPluginCli([
      'plugin',
      'install',
      'remote-index-plugin-test',
      '--index-url',
      indexUrl,
      '--plugin-dir',
      pluginDirectory,
      '--json',
    ])
    const installResult = parseJson(installOutput) as {
      pluginId: string
      artifactUrl: string
      descriptor: { id: string }
    }

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(installResult).toMatchObject({
      pluginId: 'remote-index-plugin-test',
      artifactUrl,
      descriptor: { id: 'remote-index-plugin-test' },
    })
  })
})
