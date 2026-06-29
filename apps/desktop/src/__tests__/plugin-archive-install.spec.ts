import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import path from 'path'

import { createDesktopNodePluginRuntimeService } from '@bitsentry-ce/core/features/plugins/node'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type TarModule = {
  c(
    options: {
      cwd: string
      file: string
      gzip: boolean
    },
    entries: string[],
  ): Promise<void>
}

describe('desktop code plugin archive installation', () => {
  const tempRoots: string[] = []
  const originalCwd = process.cwd()

  afterEach(async () => {
    process.chdir(originalCwd)
    await Promise.all(
      tempRoots.map((tempRoot) => rm(tempRoot, { recursive: true, force: true })),
    )
    tempRoots.length = 0
  })

  async function writeMarketplaceArchive(input: {
    tempRoot: string
    pluginId: string
    pluginBody?: string
    files?: Record<string, string>
  }): Promise<string> {
    const sourceRoot = path.join(input.tempRoot, `${input.pluginId}-source`)
    const pluginRoot = path.join(sourceRoot, input.pluginId)
    const archivePath = path.join(input.tempRoot, `${input.pluginId}.tar.gz`)

    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      path.join(pluginRoot, 'plugin.js'),
      input.pluginBody ??
        `
exports.plugin = {
  id: '${input.pluginId}',
  name: 'Marketplace Test',
  version: '1.0.0',
  description: 'A marketplace-installed code plugin.',
  auth: { fields: [] },
  actions: [
    {
      id: 'ping',
      title: 'Ping',
      description: 'Proves the installed code plugin can execute.',
      riskLevel: 'read',
      fields: [],
      execute() {
        return {
          ok: true,
          status: 200,
          summary: 'pong from installed plugin',
          data: { source: 'archive' },
        }
      },
    },
  ],
  triggers: [],
}
`,
    )
    for (const [relativePath, content] of Object.entries(input.files ?? {})) {
      const targetPath = path.join(pluginRoot, relativePath)
      await mkdir(path.dirname(targetPath), { recursive: true })
      await writeFile(targetPath, content)
    }

    const tar = (await import(require.resolve('tar'))) as TarModule
    await tar.c(
      {
        cwd: sourceRoot,
        file: archivePath,
        gzip: true,
      },
      [input.pluginId],
    )

    return archivePath
  }

  it('installs a tarred plugin.js archive and reloads it for execution', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-test-'))
    tempRoots.push(tempRoot)

    const installRoot = path.join(tempRoot, 'installed')
    const archivePath = await writeMarketplaceArchive({
      tempRoot,
      pluginId: 'marketplace-test',
    })

    const service = createDesktopNodePluginRuntimeService([installRoot])
    const archiveBase64 = (await readFile(archivePath)).toString('base64')
    const installResult = await service.installFromArchive({ archiveBase64 })

    expect(installResult.pluginId).toBe('marketplace-test')
    expect(installResult.descriptor.name).toBe('Marketplace Test')
    expect(service.getPlugin('marketplace-test')?.version).toBe('1.0.0')

    await expect(
      service.executeAction({
        pluginId: 'marketplace-test',
        actionId: 'ping',
        auth: {},
        input: {},
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      summary: 'pong from installed plugin',
      data: { source: 'archive' },
    })
  })

  it('installs a package-shaped archive with helper modules beside plugin.js', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-test-'))
    tempRoots.push(tempRoot)

    const installRoot = path.join(tempRoot, 'installed')
    const archivePath = await writeMarketplaceArchive({
      tempRoot,
      pluginId: 'github-pack-style',
      pluginBody: `
const { formatIssueQuery } = require('./lib/github-helper')

exports.plugin = {
  id: 'github-pack-style',
  name: 'GitHub Pack Style',
  version: '1.0.0',
  description: 'A package-shaped code plugin with shared helper code.',
  auth: { fields: [] },
  actions: [
    {
      id: 'listIssues',
      title: 'List Issues',
      description: 'Uses helper code packaged beside the plugin entrypoint.',
      riskLevel: 'read',
      fields: [
        { key: 'owner', label: 'Owner', type: 'string', required: true },
        { key: 'repo', label: 'Repo', type: 'string', required: true },
      ],
      execute(context) {
        return {
          ok: true,
          status: 200,
          summary: formatIssueQuery(context.input),
          data: { pluginRoot: context.host.pluginRoot },
        }
      },
    },
  ],
  triggers: [],
}
`,
      files: {
        'lib/github-helper.js': `
exports.formatIssueQuery = function formatIssueQuery(input) {
  return 'issues for ' + input.owner + '/' + input.repo
}
`,
      },
    })

    const service = createDesktopNodePluginRuntimeService([installRoot])
    const archiveBase64 = (await readFile(archivePath)).toString('base64')
    const installResult = await service.installFromArchive({ archiveBase64 })

    expect(installResult.pluginId).toBe('github-pack-style')
    expect(installResult.extractedEntryPath).toBe(
      path.join('github-pack-style', 'plugin.js'),
    )

    await expect(
      service.executeAction({
        pluginId: 'github-pack-style',
        actionId: 'listIssues',
        auth: {},
        input: {
          owner: 'bitsentry-ai',
          repo: 'monorepo',
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      summary: 'issues for bitsentry-ai/monorepo',
      data: {
        pluginRoot: path.join(installRoot, 'github-pack-style'),
      },
    })
  })

  it('installs archive plugins into the workspace user plugin directory by default', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-test-'))
    tempRoots.push(tempRoot)

    const workspaceRoot = path.join(tempRoot, 'workspace')
    await mkdir(path.join(workspaceRoot, 'apps', 'desktop-ce', 'packages', 'plugins'), {
      recursive: true,
    })
    await writeFile(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'packages: []\n')

    const archivePath = await writeMarketplaceArchive({
      tempRoot,
      pluginId: 'workspace-install-test',
    })

    process.chdir(workspaceRoot)

    const service = createDesktopNodePluginRuntimeService()
    const archiveBase64 = (await readFile(archivePath)).toString('base64')
    const installResult = await service.installFromArchive({ archiveBase64 })
    const expectedInstalledPath = path.join(
      workspaceRoot,
      '.bitsentry',
      'plugins',
      'workspace-install-test',
    )

    expect(installResult.pluginId).toBe('workspace-install-test')
    await expect(realpath(installResult.installedPath)).resolves.toBe(
      await realpath(expectedInstalledPath),
    )
    expect(service.getPlugin('workspace-install-test')?.version).toBe('1.0.0')
  })

  it('passes plugin host APIs to error-source code hooks', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-test-'))
    tempRoots.push(tempRoot)

    const pluginsRoot = path.join(tempRoot, 'plugins')
    const pluginRoot = path.join(pluginsRoot, 'hosted-source')
    const entryPath = path.join(pluginRoot, 'plugin.js')

    await mkdir(pluginRoot, { recursive: true })
    await writeFile(
      entryPath,
      `
exports.plugin = {
  id: 'hosted-source',
  name: 'Hosted Source',
  version: '1.0.0',
  description: 'A code plugin with error-source hooks.',
  metadata: {
    errorSource: {
      sourceType: 'github',
      setupFields: [],
    },
  },
  auth: { fields: [] },
  actions: [],
  triggers: [],
  errorSource: {
    resolveSetup(context) {
      return {
        accessTokenRef: 'setup-token',
        configuration: {
          pluginRoot: context.host.pluginRoot,
          entryPath: context.host.entryPath,
          installRoot: context.host.localPluginDirectories[0],
          issueQuery: context.setupValues.issueQuery,
        },
      }
    },
    buildAuth(context) {
      return {
        pluginRoot: context.host.pluginRoot,
        accessToken: context.source.accessTokenRef,
        owner: context.source.configuration.owner,
      }
    },
    buildProbeAuth(context) {
      return {
        entryPath: context.host.entryPath,
        accessToken: context.persistedSetup.accessTokenRef,
      }
    },
  },
}
`,
    )

    const service = createDesktopNodePluginRuntimeService([pluginsRoot])

    await expect(
      service.resolveErrorSourceSetup({
        pluginId: 'hosted-source',
        setupValues: {
          issueQuery: 'is:issue is:open',
        },
      }),
    ).resolves.toMatchObject({
      accessTokenRef: 'setup-token',
      configuration: {
        pluginRoot,
        entryPath,
        installRoot: pluginsRoot,
        issueQuery: 'is:issue is:open',
      },
    })

    await expect(
      service.buildErrorSourceAuth({
        pluginId: 'hosted-source',
        source: {
          sourceType: 'github',
          accessTokenRef: 'stored-token',
          configuration: {
            owner: 'bitsentry-ai',
          },
        },
      }),
    ).resolves.toEqual({
      pluginRoot,
      accessToken: 'stored-token',
      owner: 'bitsentry-ai',
    })

    await expect(
      service.buildErrorSourceProbeAuth({
        pluginId: 'hosted-source',
        persistedSetup: {
          accessTokenRef: 'probe-token',
          configuration: {},
        },
      }),
    ).resolves.toEqual({
      entryPath,
      accessToken: 'probe-token',
    })
  })
})
