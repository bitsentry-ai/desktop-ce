import { describe, expect, it } from 'vitest'
import {
  describeIntegrationConnection,
  desktopCodePluginSchema,
  desktopPluginDescriptorSchema,
  DesktopPluginRegistry,
  DesktopPluginRuntimeService,
  IntegrationOperationService,
  refreshLinkedIntegrationResource,
  StoredIntegrationResources,
  validateIntegrationConnection,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthStore,
  type IntegrationConnectionInput,
  type IntegrationResource,
  type IntegrationWriteRuntime,
} from '../src/features/plugins'
import { IntegrationConnectionStore } from '../src/features/plugins/integration-connection-store'
import { StoredIntegrationOperations } from '../src/features/plugins/integration-operation-store'

const plugin = desktopPluginDescriptorSchema.parse({
  id: 'third-party.time', name: 'Custom time tracker', version: '1', description: 'Example configurable adapter',
  auth: {
    fields: [
      { key: 'apiKey', label: 'Key', type: 'string', required: false, secret: true },
      { key: 'user', label: 'User', type: 'string', required: false },
      { key: 'password', label: 'Password', type: 'string', required: false, secret: true },
    ],
    requiredSets: [['apiKey'], ['user', 'password']],
  },
  actions: [
    { id: 'read_entry', title: 'Read entry', description: 'Read entry', riskLevel: 'read', fields: [{ key: 'id', label: 'ID', type: 'number', required: true }] },
    { id: 'log_time', title: 'Log time', description: 'Log time', riskLevel: 'write', fields: [{ key: 'seconds', label: 'Seconds', type: 'number', required: true }] },
  ],
  metadata: { persistence: { configVersion: 2, destinationField: 'serviceUrl', configFields: [
    { key: 'serviceUrl', label: 'Service', type: 'string', required: true },
    { key: 'project', label: 'Project', type: 'string', required: false },
    { key: 'mapping', label: 'Mapping', type: 'json', required: false },
  ], resources: [{ type: 'time_entry', stateVersion: 1, readActionId: 'read_entry' }], eventChannels: [] } },
})
const connectionId = '50000000-0000-4000-8000-000000000001'
const input: IntegrationConnectionInput = {
  id: connectionId, name: 'Custom timer', pluginId: plugin.id, enabled: true,
  configVersion: 2, config: { serviceUrl: 'https://timer.example.test/api', project: 'ops' }, auth: { apiKey: 'private-value' },
}

function credentials(): DesktopPluginStoredAuthStore {
  const values = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    get: async (id) => values.get(id) ?? {},
    set: async (id, value) => { values.set(id, structuredClone(value)); return value },
    clear: async (id) => { values.delete(id) },
  }
}

describe('generic named connection contract', () => {
  it('admits a new plugin from its descriptor and exposes no credentials', () => {
    const connection = validateIntegrationConnection(input, plugin)
    const publicConnection = describeIntegrationConnection(connection, plugin)
    expect(publicConnection.pluginId).toBe('third-party.time')
    expect(publicConnection.target).toBe('https://timer.example.test/api')
    expect(publicConnection.configVersion).toBe(2)
    expect(JSON.stringify(publicConnection)).not.toContain('private-value')
    expect(publicConnection).not.toHaveProperty('auth')
  })

  it('rejects a missing plugin, incompatible configuration, credentials in JSON and an unusable destination', () => {
    expect(() => validateIntegrationConnection(input)).toThrow()
    expect(() => validateIntegrationConnection({ ...input, configVersion: 1 }, plugin)).toThrow()
    expect(() => validateIntegrationConnection({ ...input, config: { ...input.config, mapping: { apiKey: 'private-value' } } }, plugin)).toThrow()
    expect(() => validateIntegrationConnection({ ...input, config: { serviceUrl: 'https://user:pass@timer.example.test/api' } }, plugin)).toThrow()
  })

  it('accepts either complete credential set and refuses a half set', () => {
    expect(() => validateIntegrationConnection({ ...input, auth: { user: 'engineer', password: 'private-value' } }, plugin)).not.toThrow()
    expect(() => validateIntegrationConnection({ ...input, auth: { user: 'engineer' } }, plugin)).toThrow('credentials are incomplete')
  })

  it('keeps an iTop ticket mapping that is sent beside the configuration', () => {
    const itop = desktopPluginDescriptorSchema.parse({
      id: 'itop', name: 'iTop', version: '1', description: 'Tickets',
      auth: { fields: [{ key: 'authToken', label: 'Token', type: 'string', required: false, secret: true }] },
      actions: [{ id: 'get_object', title: 'Get', description: 'Get', riskLevel: 'read', fields: [] }],
      metadata: { persistence: { configVersion: 1, destinationField: 'endpoint', configFields: [
        { key: 'endpoint', label: 'Instance URL', type: 'string', required: true },
        { key: 'ticketMapping', label: 'Mapping', type: 'json', required: false },
      ], resources: [{ type: 'ticket', stateVersion: 1, readActionId: 'get_object' }], eventChannels: [] } },
    })
    const mapping = {
      className: 'Incident', fields: { title: 'title' },
      requiredFields: { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] },
      stimuli: {},
    }
    const base = { id: connectionId, name: 'Service desk', pluginId: 'itop', enabled: true, configVersion: 1, auth: { authToken: 'private-value' } }

    const beside = validateIntegrationConnection({ ...base, config: { endpoint: 'https://itop.example.test' }, ticketMapping: mapping }, itop)
    const inside = validateIntegrationConnection({ ...base, config: { endpoint: 'https://itop.example.test', ticketMapping: mapping } }, itop)
    const none = validateIntegrationConnection({ ...base, config: { endpoint: 'https://itop.example.test' } }, itop)

    expect(beside.ticketMapping).toMatchObject({ className: 'Incident' })
    expect(beside.config).toMatchObject({ ticketMapping: { className: 'Incident' } })
    expect(inside.ticketMapping).toMatchObject({ className: 'Incident' })
    expect(none.ticketMapping).toBeUndefined()
    expect(none.config).not.toHaveProperty('ticketMapping')
  })

  it('reports the endpoint the requests really use, never a separate stored copy', () => {
    const stored = { ...input, target: 'https://approved.example.test/api' }
    expect(() => validateIntegrationConnection(stored, plugin)).toThrow()
    expect(describeIntegrationConnection({ ...input }, plugin).target).toBe('https://timer.example.test/api')
  })
})

describe('editing a stored connection', () => {
  async function stored() {
    const store = new IntegrationConnectionStore(credentials())
    await store.save(input, plugin)
    return store
  }

  it('keeps the stored credentials when only the name or a provider setting changes', async () => {
    const store = await stored()
    await store.save({ ...input, name: 'Renamed timer', config: { ...input.config, project: 'platform' }, auth: {} }, plugin)

    const [row] = await store.list()
    expect(row).toMatchObject({ name: 'Renamed timer', config: { project: 'platform' }, auth: { apiKey: 'private-value' } })
  })

  it('does not send stored credentials to a destination the engineer did not enter them for', async () => {
    const store = await stored()
    await expect(store.save({ ...input, config: { serviceUrl: 'https://elsewhere.example.test/api' }, auth: {} }, plugin)).rejects.toThrow('credentials are incomplete')

    const [row] = await store.list()
    expect(row?.config).toMatchObject({ serviceUrl: 'https://timer.example.test/api' })
  })

  it('replaces the whole credential set when new credentials are given', async () => {
    const store = await stored()
    await store.save({ ...input, auth: { user: 'engineer', password: 'new-password' } }, plugin)

    const [row] = await store.list()
    expect(row?.auth).toEqual({ user: 'engineer', password: 'new-password' })
  })

  it('keeps a disabled connection disabled and a stored connection on the plugin it was created for', async () => {
    const store = await stored()
    await store.save({ ...input, enabled: false, auth: {} }, plugin)
    expect((await store.list())[0]?.enabled).toBe(false)

    await expect(store.save({ ...input, pluginId: 'other.plugin', auth: {} }, plugin)).rejects.toThrow()
  })

  it('makes an approval for an earlier setting stale even when the destination stays the same', async () => {
    const store = await stored()
    const executed: unknown[] = []
    const operations = new StoredIntegrationOperations(credentials())
    const resolve = async (id: string): Promise<IntegrationWriteRuntime> => {
      const row = (await store.list()).find((item) => item.id === id)!
      const execute = async (request: unknown) => { executed.push(request); return { ok: true, status: 200, data: {} } }
      return { connection: describeIntegrationConnection(row, plugin), plugin, execute, read: execute } as unknown as IntegrationWriteRuntime
    }
    const service = new IntegrationOperationService(operations, resolve)
    const proposal = await service.propose('thread', { connectionId, actionId: 'log_time', input: { seconds: 60 } })

    await store.save({ ...input, config: { ...input.config, project: 'a-different-project' }, auth: {} }, plugin)

    await expect(service.approve('thread', proposal.id, false)).rejects.toThrow('Connection changed')
    expect(executed).toEqual([])
  })
})

describe('reading generic resources through the plugin declared action', () => {
  const resource: IntegrationResource = {
    threadId: 'thread', connectionId, connectionName: 'Custom timer', resourceType: 'time_entry', externalId: '42',
    url: 'https://timer.example.test/42', title: 'Investigation', state: { seconds: 15 }, stateVersion: 1,
    observedAt: '2026-10-01T00:00:00.000Z', selected: true,
  }

  it('refreshes a resource with the id in the form its read action declares', async () => {
    let value: DesktopPluginStoredAuthRecord = { resources: JSON.stringify([resource]) }
    const store = new StoredIntegrationResources({ get: async () => value, set: async (_id, next) => { value = next; return next }, clear: async () => {} })
    const reads: Array<Record<string, unknown>> = []
    const read = async (request: { actionId: string; input: Record<string, unknown> }) => {
      reads.push(request.input)
      return { ok: true, status: 200, data: { resources: [{ resourceType: 'time_entry', stateVersion: 1, externalId: '42', title: 'Investigation', url: 'https://timer.example.test/42', state: { seconds: 30 } }] } }
    }
    const runtime = { connection: describeIntegrationConnection(validateIntegrationConnection(input, plugin), plugin), plugin, execute: read, read } as unknown as IntegrationWriteRuntime

    const refreshed = await refreshLinkedIntegrationResource({ threadId: 'thread', connectionId, resourceType: 'time_entry', externalId: '42' }, store, runtime)

    expect(refreshed).toMatchObject({ externalId: '42', state: { seconds: 30 }, selected: true })
    expect(reads).toEqual([{ id: 42 }])
  })
})

describe('plugin execution', () => {
  it('validates configuration before plugin execution and validates generic resource state before returning it', async () => {
    let calls = 0
    let state: Record<string, unknown> = { seconds: 15 }
    const code = desktopCodePluginSchema.parse({ ...plugin,
      persistence: { validateConfig: (value: Record<string, unknown>) => value, validateResourceState: ({ state: value }: { state: unknown }) => value },
      actions: [{ ...plugin.actions[0], execute: ({ config }: { config?: Record<string, unknown> }) => {
        calls += 1
        expect(config).toEqual(input.config)
        return { ok: true, status: 200, summary: 'Entry', data: { resources: [{ resourceType: 'time_entry', stateVersion: 1, externalId: '42', title: 'Investigation', url: 'https://timer.example.test/42', state }] } }
      } }],
    })
    const runtime = new DesktopPluginRuntimeService(new DesktopPluginRegistry([{ plugin: code, entryPath: '/example/plugin.js', pluginRoot: '/example', referenceRepositoryPath: '/example' }]))
    const request = { pluginId: plugin.id, actionId: 'read_entry', input: { id: 42 }, auth: input.auth, connectionConfig: { version: 2, value: input.config as Record<string, unknown> } }
    await expect(runtime.executeAction({ ...request, connectionConfig: { ...request.connectionConfig, version: 1 } })).rejects.toThrow('upgrade_required')
    expect(calls).toBe(0)
    await expect(runtime.executeAction(request)).resolves.toMatchObject({ ok: true })
    state = { apiKey: 'private-value' }
    await expect(runtime.executeAction(request)).rejects.toThrow('invalid_configuration')
  })

  it('refuses to run with an incomplete credential set', async () => {
    const code = desktopCodePluginSchema.parse({ ...plugin,
      persistence: { validateConfig: (value: Record<string, unknown>) => value, validateResourceState: ({ state: value }: { state: unknown }) => value },
      actions: [{ ...plugin.actions[0], execute: () => ({ ok: true, status: 200, summary: 'Entry', data: {} }) }],
    })
    const runtime = new DesktopPluginRuntimeService(new DesktopPluginRegistry([{ plugin: code, entryPath: '/example/plugin.js', pluginRoot: '/example', referenceRepositoryPath: '/example' }]))
    await expect(runtime.executeAction({ pluginId: plugin.id, actionId: 'read_entry', input: { id: 42 }, auth: { user: 'engineer' }, connectionConfig: { version: 2, value: input.config as Record<string, unknown> } })).rejects.toThrow('credentials are incomplete')
  })
})
