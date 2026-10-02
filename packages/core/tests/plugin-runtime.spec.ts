import { spawnSync } from 'child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

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

  it('loads the local plugin loader from an ESM entrypoint', () => {
    const runtimeEntryPath = path.resolve(
      __dirname,
      '../src/features/plugins/desktop-local-plugin-loader.ts',
    )
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `const loader = await import(${JSON.stringify(pathToFileURL(runtimeEntryPath).href)}); loader.loadDesktopLocalPlugins([]);`,
      ],
      {
        cwd: originalCwd,
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('__filename is not defined')
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

  it('rejects a write action called as a read without executing it', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-code-plugin-'))

    try {
      const pluginRoot = path.join(tempRoot, 'plugins')
      const writeMarkerPath = path.join(tempRoot, 'write-executed')
      await writeCodePlugin({
        root: pluginRoot,
        pluginId: 'ticket-desk',
        source: `
          module.exports = {
            id: "ticket-desk",
            name: "Ticket Desk",
            version: "0.1.0",
            description: "Fixture plugin with a write action.",
            auth: { fields: [] },
            actions: [
              {
                id: "update_ticket",
                title: "Update Ticket",
                description: "Changes a remote ticket.",
                riskLevel: "write",
                fields: [],
                async execute() {
                  require("fs").writeFileSync(${JSON.stringify(writeMarkerPath)}, "written");
                  return { status: 200, summary: "Ticket updated." };
                },
              },
            ],
          };
        `,
      })

      const service = createDesktopNodePluginRuntimeService([pluginRoot])

      await expect(
        service.executeAction(
          { pluginId: 'ticket-desk', actionId: 'update_ticket', auth: {}, input: {} },
          undefined,
          { requiredRiskLevel: 'read' },
        ),
      ).rejects.toThrow('is not a read action')
      await expect(access(writeMarkerPath)).rejects.toThrow()
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('passes parent operation metadata to local code plugin actions', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-plugin-operation-'))

    try {
      const pluginRoot = path.join(tempRoot, 'plugins')
      await writeCodePlugin({
        root: pluginRoot,
        pluginId: 'operation-aware',
        source: `
          module.exports = {
            id: "operation-aware",
            name: "Operation Aware",
            version: "0.1.0",
            description: "Reads host-owned operation metadata.",
            auth: { fields: [] },
            actions: [
              {
                id: "inspect_operation",
                title: "Inspect operation",
                description: "Returns the host execution metadata.",
                riskLevel: "read",
                fields: [],
                execute(context) {
                  return {
                    status: 200,
                    summary: "Operation inspected.",
                    data: {
                      executionId: context.operation?.executionId,
                      deadlineAt: context.operation?.deadlineAt,
                      aborted: context.operation?.signal?.aborted,
                    },
                  };
                },
              },
            ],
          };
        `,
      })

      const controller = new AbortController()
      const service = createDesktopNodePluginRuntimeService([pluginRoot])
      const result = await service.executeAction({
        pluginId: 'operation-aware',
        actionId: 'inspect_operation',
        auth: {},
        input: {},
      }, {
        signal: controller.signal,
        deadlineAt: 1_700_000_000_000,
        executionId: 'execution-123',
      })

      expect(result.data).toEqual({
        executionId: 'execution-123',
        deadlineAt: 1_700_000_000_000,
        aborted: false,
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('imports every first-party plugin artifact through the local runtime loader', async () => {
    const artifactRoot = path.resolve(__dirname, '../../../build/plugins')
    const expectedPluginIds = [
      'github',
      'itop',
      'linux-cve-status',
      'outline',
      'posthog',
      'sentry',
      'wazuh',
    ]

    await Promise.all(
      expectedPluginIds.map((pluginId) =>
        access(path.join(artifactRoot, `${pluginId}.plugin.js`)),
      ),
    )

    const service = createDesktopNodePluginRuntimeService([artifactRoot])

    expect(service.listPlugins().map((plugin) => plugin.id).sort()).toEqual(
      expectedPluginIds,
    )

    for (const pluginId of expectedPluginIds) {
      expect(service.getPlugin(pluginId)).toMatchObject({
        id: pluginId,
      })
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

  it('executes the selected integration connection and returns credential-free descriptors', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'bitsentry-itop-connection-'))

    try {
      const pluginRoot = path.join(tempRoot, 'plugins')
      await writeCodePlugin({
        root: pluginRoot,
        pluginId: 'itop',
        source: `
          module.exports = {
            id: "itop",
            name: "iTop",
            version: "1.0.0",
            description: "Test integration connection routing.",
            auth: { fields: [
              { key: "baseUrl", label: "Base URL", type: "string", required: true },
              { key: "authToken", label: "API token", type: "string", required: true, secret: true }
            ] },
            actions: [{
              id: "read_target",
              title: "Read target",
              description: "Returns the configured target.",
              riskLevel: "read",
              fields: [],
              async execute(context) {
                return { status: 200, summary: context.auth.baseUrl, data: { target: context.auth.baseUrl } };
              }
            }]
          };
        `,
      })
      const values = new Map<string, DesktopPluginStoredAuthRecord>()
      values.set('itop', { authToken: 'legacy-default-secret' })
      const service = createDesktopNodePluginRuntimeService([pluginRoot], {
        get: async (key) => values.get(key) ?? {},
        set: async (key, value) => { values.set(key, value); return value },
        clear: async (key) => { values.delete(key) },
      })
      const production = {
        id: '11111111-1111-4111-8111-111111111111', name: 'Production', pluginId: 'itop' as const,
        enabled: true, auth: { baseUrl: 'https://production.itop.example', authToken: 'production-secret' },
      }
      const staging = {
        id: '22222222-2222-4222-8222-222222222222', name: 'Staging', pluginId: 'itop' as const,
        enabled: true, auth: { baseUrl: 'https://staging.itop.example', authToken: 'staging-secret' },
      }
      const disabled = {
        id: '33333333-3333-4333-8333-333333333333', name: 'Disabled', pluginId: 'itop' as const,
        enabled: false, auth: { baseUrl: 'https://disabled.itop.example', authToken: 'disabled-secret' },
      }
      await Promise.all([
        service.saveIntegrationConnection(production),
        service.saveIntegrationConnection(staging),
        service.saveIntegrationConnection(disabled),
      ])
      const missingSecret = {
        id: '44444444-4444-4444-8444-444444444444', name: 'Missing secret', pluginId: 'itop',
        enabled: true, auth: { baseUrl: 'https://missing.itop.example', authToken: '' },
      }
      values.set('bitsentry.integration-connections.v1', {
        connections: JSON.stringify([production, staging, disabled, missingSecret]),
      })

      const descriptors = await service.listIntegrationConnections()
      expect(descriptors.map(({ id, target }) => ({ id, target }))).toEqual([
        { id: production.id, target: `${production.auth.baseUrl}/` },
        { id: staging.id, target: `${staging.auth.baseUrl}/` },
        { id: disabled.id, target: `${disabled.auth.baseUrl}/` },
        { id: missingSecret.id, target: `${missingSecret.auth.baseUrl}/` },
      ])
      expect(descriptors.find(({ id }) => id === missingSecret.id)?.availability).toBe('credentials_missing')
      expect(JSON.stringify(descriptors)).not.toContain('production-secret')
      expect(JSON.stringify(descriptors)).not.toContain('staging-secret')
      expect(JSON.stringify(descriptors)).not.toContain('disabled-secret')
      expect(JSON.stringify(descriptors)).not.toContain('legacy-default-secret')

      const result = await service.executeIntegrationAction({
        connectionId: staging.id, actionId: 'read_target', input: {},
      })
      expect(result.data).toEqual({ target: staging.auth.baseUrl })
      await expect(service.executeIntegrationAction({
        connectionId: disabled.id, actionId: 'read_target', input: {},
      })).rejects.toThrow('missing or disabled')
      await expect(service.executeIntegrationAction({
        connectionId: '55555555-5555-4555-8555-555555555555', actionId: 'read_target', input: {},
      })).rejects.toThrow('missing or disabled')
      await expect(service.executeIntegrationAction({
        connectionId: missingSecret.id, actionId: 'read_target', input: {},
      })).rejects.toThrow('Missing required auth field: authToken')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})
