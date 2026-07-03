import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import { afterEach, describe, expect, it } from 'vitest'

describe('desktop code plugin artifact installation', () => {
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
  triggers: [],
}
`
  }

  function artifactBase64(source: string): string {
    return Buffer.from(source, 'utf-8').toString('base64')
  }

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
})
