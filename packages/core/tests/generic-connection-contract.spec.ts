import { describe, expect, it } from 'vitest';
import { desktopCodePluginSchema, DesktopPluginRegistry, DesktopPluginRuntimeService, desktopPluginDescriptorSchema, describeIntegrationConnection, validateIntegrationConnection } from '../src/features/plugins';

const plugin = desktopPluginDescriptorSchema.parse({
  id: 'third-party.time', name: 'Custom time tracker', version: '1', description: 'Example configurable adapter',
  auth: { fields: [{ key: 'apiKey', label: 'Key', type: 'string', required: true, secret: true }] },
  actions: [{ id: 'read_entry', title: 'Read entry', description: 'Read entry', riskLevel: 'read', fields: [] }],
  metadata: { persistence: { configVersion: 2, destinationField: 'serviceUrl', configFields: [
    { key: 'serviceUrl', label: 'Service', type: 'string', required: true },
    { key: 'mapping', label: 'Mapping', type: 'json', required: false },
  ], resources: [{ type: 'time_entry', stateVersion: 1, readActionId: 'read_entry' }], eventChannels: [] } },
});
const input = { id: '50000000-0000-4000-8000-000000000001', name: 'Custom timer', pluginId: plugin.id, enabled: true,
  configVersion: 2, config: { serviceUrl: 'https://timer.example.test/api' }, auth: { apiKey: 'private-value' },
};

describe('generic named connection contract', () => {
  it('admits a new plugin from its descriptor and exposes no credentials', () => {
    const connection = validateIntegrationConnection(input, plugin);
    const publicConnection = describeIntegrationConnection(connection, plugin);
    expect(publicConnection.pluginId).toBe('third-party.time');
    expect(publicConnection.target).toBe('https://timer.example.test/api');
    expect(publicConnection.configVersion).toBe(2);
    expect(JSON.stringify(publicConnection)).not.toContain('private-value');
    expect(publicConnection).not.toHaveProperty('auth');
  });
  it('rejects a missing plugin, incompatible configuration and credentials in JSON', () => {
    expect(() => validateIntegrationConnection(input)).toThrow();
    expect(() => validateIntegrationConnection({ ...input, configVersion: 1 }, plugin)).toThrow();
    expect(() => validateIntegrationConnection({ ...input, config: { ...input.config, mapping: { apiKey: 'private-value' } } }, plugin)).toThrow();
    expect(() => validateIntegrationConnection({ ...input, target: 'https://different.example.test' }, plugin)).toThrow();
  });
});


it('validates configuration before plugin execution and validates generic resource state before returning it', async () => {
  let calls = 0;
  let state: Record<string, unknown> = { seconds: 15 };
  const code = desktopCodePluginSchema.parse({ ...plugin,
    persistence: { validateConfig: (value: Record<string, unknown>) => value, validateResourceState: ({ state: value }: { state: unknown }) => value },
    actions: [{ ...plugin.actions[0], execute: ({ config }: { config?: Record<string, unknown> }) => {
      calls += 1;
      expect(config).toEqual(input.config);
      return { ok: true, status: 200, summary: 'Entry', data: { resources: [{ resourceType: 'time_entry', stateVersion: 1, externalId: '42', title: 'Investigation', url: 'https://timer.example.test/42', state }] } };
    } }],
  });
  const runtime = new DesktopPluginRuntimeService(new DesktopPluginRegistry([{ plugin: code, entryPath: '/example/plugin.js', pluginRoot: '/example', referenceRepositoryPath: '/example' }]));
  const request = { pluginId: plugin.id, actionId: 'read_entry', input: {}, auth: input.auth, connectionConfig: { version: 2, value: input.config } };
  await expect(runtime.executeAction({ ...request, connectionConfig: { ...request.connectionConfig, version: 1 } })).rejects.toThrow('upgrade_required');
  expect(calls).toBe(0);
  await expect(runtime.executeAction(request)).resolves.toMatchObject({ ok: true });
  state = { apiKey: 'private-value' };
  await expect(runtime.executeAction(request)).rejects.toThrow('invalid_configuration');
  expect(calls).toBe(2);
});
