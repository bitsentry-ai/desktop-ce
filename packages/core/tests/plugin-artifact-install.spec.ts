import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { createDesktopNodePluginRuntimeService } from '../src/features/plugins/node'
import { afterEach, describe, expect, it } from 'vitest'

describe('code plugin artifact installation', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    )
    tempRoots.length = 0
  })

  async function createTempRoot(): Promise<string> {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-artifact-'))
    tempRoots.push(tempRoot)
    return tempRoot
  }

  function pluginArtifactSource(input: {
    pluginId: string
    summary: string
  }): string {
    return `
exports.plugin = {
  id: '${input.pluginId}',
  name: 'Artifact Plugin',
  version: '1.0.0',
  description: 'A single-file BitSentry code plugin artifact.',
  auth: { fields: [] },
  actions: [
    {
      id: 'ping',
      title: 'Ping',
      description: 'Confirms the installed artifact can execute.',
      riskLevel: 'read',
      fields: [],
      execute(context) {
        return {
          ok: true,
          status: 200,
          summary: '${input.summary}',
          data: {
            pluginId: context.pluginId,
            pluginRoot: context.host.pluginRoot,
          },
        }
      },
    },
  ],
}
`
  }

  function artifactBase64(source: string): string {
    return Buffer.from(source, 'utf-8').toString('base64')
  }

  function versionedPluginArtifactSource(patch = ''): string {
    return `${pluginArtifactSource({
      pluginId: 'artifact-plugin-test',
      summary: 'pong from versioned artifact',
    })}
exports.plugin.auth.fields = [
  { key: 'apiKey', label: 'API Key', type: 'string', secret: true },
]
exports.plugin.metadata = {
  persistence: {
    configVersion: 2,
    configFields: [
      { key: 'baseUrl', label: 'URL', type: 'string', required: true },
      { key: 'mapping', label: 'Mapping', type: 'json' },
    ],
    destinationField: 'baseUrl',
    resources: [{ type: 'case', stateVersion: 3, readActionId: 'ping' }],
    eventChannels: ['case.changed'],
  },
}
exports.plugin.persistence = {
  validateConfig: (config) => config,
  validateResourceState: ({ state }) => state,
}
${patch}
`
  }

  const invalidPersistenceContracts = [
    ['missing handlers', 'delete exports.plugin.persistence'],
    ['missing metadata', 'delete exports.plugin.metadata'],
    ['invalid configuration version', 'exports.plugin.metadata.persistence.configVersion = 0'],
    ['invalid resource version', 'exports.plugin.metadata.persistence.resources[0].stateVersion = 0'],
    ['secret configuration fields', 'exports.plugin.metadata.persistence.configFields[1].secret = true'],
    ['credential names in configuration', 'exports.plugin.metadata.persistence.configFields[1].key = "apiKey"'],
    ['undeclared recovery actions', 'exports.plugin.metadata.persistence.resources[0].readActionId = "missing"'],
    ['write recovery actions', 'exports.plugin.actions[0].riskLevel = "write"'],
  ]

  it('installs a single-file plugin artifact and reloads it for execution', async () => {
    const tempRoot = await createTempRoot()
    const installRoot = path.join(tempRoot, 'plugins')
    const service = createDesktopNodePluginRuntimeService([installRoot])

    const installResult = await service.installFromArtifact({
      artifactBase64: artifactBase64(pluginArtifactSource({
        pluginId: 'artifact-plugin-test',
        summary: 'pong from artifact',
      })),
    })

    expect(installResult).toMatchObject({
      pluginId: 'artifact-plugin-test',
      installedPath: path.join(installRoot, 'artifact-plugin-test'),
      extractedEntryPath: 'plugin.js',
      descriptor: {
        id: 'artifact-plugin-test',
        actions: [expect.objectContaining({ id: 'ping' })],
      },
    })
    await expect(
      readdir(path.join(installRoot, 'artifact-plugin-test')),
    ).resolves.toEqual(['plugin.js'])

    await expect(
      service.executeAction({
        pluginId: 'artifact-plugin-test',
        actionId: 'ping',
        auth: {},
        input: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      summary: 'pong from artifact',
      data: {
        pluginId: 'artifact-plugin-test',
        pluginRoot: path.join(installRoot, 'artifact-plugin-test'),
      },
    })
  })

  it('replaces stale package-shaped files when updating from an artifact', async () => {
    const tempRoot = await createTempRoot()
    const installRoot = path.join(tempRoot, 'plugins')
    const stalePluginRoot = path.join(installRoot, 'artifact-plugin-test')
    await mkdir(path.join(stalePluginRoot, 'dist'), { recursive: true })
    await writeFile(path.join(stalePluginRoot, 'dist', 'helper.js'), 'exports.ok = true\n')
    await writeFile(path.join(stalePluginRoot, 'package.json'), '{"name":"stale"}\n')

    const service = createDesktopNodePluginRuntimeService([installRoot])
    await service.installFromArtifact({
      artifactBase64: artifactBase64(pluginArtifactSource({
        pluginId: 'artifact-plugin-test',
        summary: 'pong after update',
      })),
    })

    await expect(readdir(stalePluginRoot)).resolves.toEqual(['plugin.js'])
    await expect(
      service.executeAction({
        pluginId: 'artifact-plugin-test',
        actionId: 'ping',
        auth: {},
        input: {},
      }),
    ).resolves.toMatchObject({
      summary: 'pong after update',
    })
  })

  it('installs versioned metadata and executes the plugin after reopening', async () => {
    const tempRoot = await createTempRoot()
    const installRoot = path.join(tempRoot, 'plugins')
    const service = createDesktopNodePluginRuntimeService([installRoot])

    const installed = await service.installFromArtifact({
      artifactBase64: artifactBase64(versionedPluginArtifactSource()),
    })
    expect(installed.descriptor.metadata).toEqual({
      persistence: {
        configVersion: 2,
        configFields: [
          { key: 'baseUrl', label: 'URL', type: 'string', required: true },
          { key: 'mapping', label: 'Mapping', type: 'json', required: false },
        ],
        destinationField: 'baseUrl',
        resources: [{ type: 'case', stateVersion: 3, readActionId: 'ping' }],
        eventChannels: ['case.changed'],
      },
    })

    const reopened = createDesktopNodePluginRuntimeService([installRoot])
    expect(reopened.getPlugin(installed.pluginId)).toEqual(installed.descriptor)
    await expect(reopened.executeAction({
      pluginId: installed.pluginId,
      actionId: 'ping',
      auth: {},
      input: {},
    })).resolves.toMatchObject({
      ok: true,
      summary: 'pong from versioned artifact',
    })
  })

  it.each(invalidPersistenceContracts)(
    'rejects %s during installation and local loading',
    async (_name, patch) => {
      const tempRoot = await createTempRoot()
      const installRoot = path.join(tempRoot, 'plugins')
      const service = createDesktopNodePluginRuntimeService([installRoot])
      const legacySource = pluginArtifactSource({
        pluginId: 'artifact-plugin-test',
        summary: 'pong from retained artifact',
      })
      const installed = await service.installFromArtifact({
        artifactBase64: artifactBase64(legacySource),
      })
      const invalidSource = versionedPluginArtifactSource(patch)

      await expect(service.installFromArtifact({
        artifactBase64: artifactBase64(invalidSource),
      })).rejects.toThrow()
      await expect(readFile(path.join(installed.installedPath, 'plugin.js'), 'utf8'))
        .resolves.toEqual(legacySource)

      const reopened = createDesktopNodePluginRuntimeService([installRoot])
      await expect(reopened.executeAction({
        pluginId: installed.pluginId,
        actionId: 'ping',
        auth: {},
        input: {},
      })).resolves.toMatchObject({ summary: 'pong from retained artifact' })

      const localRoot = path.join(tempRoot, 'invalid-local-plugins')
      const pluginRoot = path.join(localRoot, installed.pluginId)
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(path.join(pluginRoot, 'plugin.js'), invalidSource)
      const localService = createDesktopNodePluginRuntimeService([localRoot])
      expect(localService.listPlugins()).toEqual([])
      await expect(localService.executeAction({
        pluginId: installed.pluginId,
        actionId: 'ping',
        auth: {},
        input: {},
      })).rejects.toThrow('Unknown plugin')
    },
  )
})
