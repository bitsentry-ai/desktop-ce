import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

import {
  DesktopPluginRuntimeService,
  type DesktopPluginStoredAuthRecord,
} from '../src/features/plugins'
import {
  createDesktopNodePluginRuntimeService,
  resolveDesktopPluginDirectories,
} from '../src/features/plugins/node'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalCwd = process.cwd()

async function writeCodePlugin(input: {
  root: string
  pluginId: string
  source: string
}): Promise<string> {
  const pluginDirectory = path.join(input.root, input.pluginId)
  await mkdir(pluginDirectory, { recursive: true })
  await writeFile(path.join(pluginDirectory, 'plugin.js'), input.source, 'utf8')
  return pluginDirectory
}

describe('DesktopPluginRuntimeService', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    process.chdir(originalCwd)
  })

  it('does not register built-in provider plugins without code plugin entrypoints', () => {
    const service = new DesktopPluginRuntimeService()

    expect(service.listPlugins()).toEqual([])
    expect(service.getPlugin('sentry')).toBeNull()
    expect(service.getPlugin('posthog')).toBeNull()
    expect(service.getPlugin('wazuh')).toBeNull()
    expect(service.getPlugin('github')).toBeNull()
  })

  it('loads and executes local code plugins from plugin.js entrypoints', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-code-plugin-'))

    try {
      const pluginRoot = path.join(tempRoot, 'plugins')
      await writeCodePlugin({
        root: pluginRoot,
        pluginId: 'ops-health',
        source: `
          module.exports = {
            id: "ops-health",
            name: "Ops Health",
            version: "0.1.0",
            description: "Fixture code plugin loaded from a plugin.js entrypoint.",
            auth: {
              fields: [
                {
                  key: "apiToken",
                  label: "API Token",
                  type: "string",
                  required: true,
                  secret: true,
                },
              ],
            },
            actions: [
              {
                id: "list_checks",
                title: "List Checks",
                description: "List health checks using plugin-owned code.",
                riskLevel: "read",
                fields: [
                  {
                    key: "team",
                    label: "Team",
                    type: "string",
                    required: true,
                  },
                ],
                async execute(context) {
                  return {
                    status: 200,
                    summary: "Loaded " + context.input.team + " checks.",
                    data: {
                      token: context.auth.apiToken,
                      team: context.input.team,
                      root: context.host.pluginRoot,
                    },
                  };
                },
              },
            ],
          };
        `,
      })

      const service = createDesktopNodePluginRuntimeService([pluginRoot])
      expect(service.getPlugin('ops-health')).toMatchObject({
        id: 'ops-health',
        name: 'Ops Health',
        referenceRepositoryPath: path.join(pluginRoot, 'ops-health'),
      })

      const result = await service.executeAction({
        pluginId: 'ops-health',
        actionId: 'list_checks',
        auth: {
          apiToken: 'ops-secret',
        },
        input: {
          team: 'platform',
        },
      })

      expect(result).toMatchObject({
        pluginId: 'ops-health',
        actionId: 'list_checks',
        ok: true,
        status: 200,
        summary: 'Loaded platform checks.',
        data: {
          token: 'ops-secret',
          team: 'platform',
          root: path.join(pluginRoot, 'ops-health'),
        },
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('ignores plugin.json-only directories', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-json-plugin-'))

    try {
      const pluginDirectory = path.join(tempRoot, 'plugins', 'legacy')
      await mkdir(pluginDirectory, { recursive: true })
      await writeFile(
        path.join(pluginDirectory, 'plugin.json'),
        JSON.stringify({
          id: 'legacy',
          name: 'Legacy',
          version: '0.1.0',
          description: 'This must not be loaded.',
          auth: { fields: [] },
          actions: [],
        }),
        'utf8',
      )

      const service = createDesktopNodePluginRuntimeService([
        path.join(tempRoot, 'plugins'),
      ])

      expect(service.getPlugin('legacy')).toBeNull()
      expect(service.listPlugins()).toEqual([])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('loads default plugin directories before explicit directories so explicit plugins override', () => {
    const defaultRoot = path.join(tmpdir(), 'bitsentry-default-plugins')
    const explicitRoot = path.join(tmpdir(), 'bitsentry-explicit-plugins')
    vi.stubEnv('BITSENTRY_PLUGIN_DIR', defaultRoot)

    expect(resolveDesktopPluginDirectories([explicitRoot])).toEqual([
      defaultRoot,
      explicitRoot,
    ])
  })

  it('merges typed stored auth values before code plugin execution', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-code-auth-'))

    try {
      const pluginRoot = path.join(tempRoot, 'plugins')
      await writeCodePlugin({
        root: pluginRoot,
        pluginId: 'ops-config',
        source: `
          module.exports = {
            id: "ops-config",
            name: "Ops Config",
            version: "0.1.0",
            description: "Fixture code plugin with typed auth fields.",
            auth: {
              fields: [
                { key: "includeArchived", label: "Include Archived", type: "boolean", required: false },
                { key: "retryCount", label: "Retry Count", type: "number", required: false },
                { key: "labels", label: "Labels", type: "string_array", required: false },
                { key: "metadata", label: "Metadata", type: "json", required: false },
              ],
            },
            actions: [
              {
                id: "inspect_config",
                title: "Inspect Config",
                description: "Return the merged auth payload.",
                riskLevel: "read",
                fields: [],
                async execute(context) {
                  return {
                    status: 200,
                    summary: "Config inspected.",
                    data: context.auth,
                  };
                },
              },
            ],
          };
        `,
      })

      const service = createDesktopNodePluginRuntimeService([pluginRoot], {
        get(pluginId): Promise<DesktopPluginStoredAuthRecord> {
          if (pluginId !== 'ops-config') {
            return Promise.resolve({})
          }

          return Promise.resolve({
            includeArchived: true,
            retryCount: 3,
            labels: ['alpha', 'beta'],
            metadata: {
              region: 'us-east-1',
            },
          })
        },
        set(_pluginId, values) {
          return Promise.resolve(values)
        },
        async clear() {},
      })

      const result = await service.executeAction({
        pluginId: 'ops-config',
        actionId: 'inspect_config',
        auth: {},
        input: {},
      })

      expect(result.data).toEqual({
        includeArchived: true,
        retryCount: 3,
        labels: ['alpha', 'beta'],
        metadata: {
          region: 'us-east-1',
        },
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
