import { describe, expect, it } from 'vitest'
import { IntegrationConnectionStore } from '../src/features/plugins/integration-connection-store'
import { applyIntegrationDestinationPolicy, describeIntegrationConnection, validateIntegrationConnection } from '../src/features/plugins/integration-connections'
import type { DesktopPluginStoredAuthRecord, DesktopPluginStoredAuthStore } from '../src/features/plugins/desktop-plugin-auth-store'

function credentials(): DesktopPluginStoredAuthStore {
  const values = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    get: async (id) => values.get(id) ?? {},
    set: async (id, value) => { values.set(id, structuredClone(value)); return value },
    clear: async (id) => { values.delete(id) },
  }
}
const first = { id: '11111111-1111-4111-8111-111111111111', name: 'Production', pluginId: 'itop' as const, enabled: true, auth: { baseUrl: 'https://itop.example/team', authToken: 'production-secret' } }
const second = { ...first, id: '22222222-2222-4222-8222-222222222222', name: 'Staging', auth: { baseUrl: 'https://staging.example', authToken: 'staging-secret' } }

describe('named integration credentials', () => {
  it('preserves separate instance secrets across concurrent writes and reload', async () => {
    const backing = credentials()
    const store = new IntegrationConnectionStore(backing)
    await Promise.all([store.save(first), store.save(second)])
    const reloaded = await new IntegrationConnectionStore(backing).list()
    expect(reloaded.find((row) => row.id === first.id)?.auth.authToken).toBe('production-secret')
    expect(reloaded.find((row) => row.id === second.id)?.auth.authToken).toBe('staging-secret')
    await store.remove(first.id)
    expect(await store.list()).toEqual([second])
  })

  it('does not return credentials or misrepresent a missing plugin as configured', () => {
    const descriptor = describeIntegrationConnection(first)
    expect(descriptor.availability).toBe('plugin_unavailable')
    expect(descriptor.target).toBe('https://itop.example/team')
    expect(JSON.stringify(descriptor)).not.toContain('production-secret')
    expect(descriptor).not.toHaveProperty('auth')
  })

  it('rejects ambiguous names and keeps the queue usable after rejection', async () => {
    const store = new IntegrationConnectionStore(credentials())
    await store.save(first)
    await expect(store.save({ ...second, name: 'PRODUCTION' })).rejects.toThrow('already exists')
    await store.save(second)
    expect(await store.list()).toHaveLength(2)
  })

  it('rejects endpoints that would expose credentials in a preview', () => {
    for (const baseUrl of ['https://user:password@itop.example', 'https://itop.example?token=secret', 'file:///tmp/itop']) {
      expect(() => validateIntegrationConnection({ ...first, auth: { ...first.auth, baseUrl } })).toThrow()
    }
  })
})

it('keeps linked instance identity immutable while allowing credential rotation', async () => {
  const store = new IntegrationConnectionStore(credentials())
  await store.save(first)
  await expect(store.save({ ...first, auth: second.auth })).rejects.toThrow('new named connection')
  await store.save({ ...first, auth: { ...first.auth, authToken: 'rotated' } })
  expect((await store.list())[0].auth.authToken).toBe('rotated')
})
it('reports unavailable destinations using the host exact-instance allowlist', () => {
  const connection = { ...describeIntegrationConnection(first), availability: 'configured' as const }
  expect(applyIntegrationDestinationPolicy(connection, {}).availability).toBe('destination_blocked')
  expect(applyIntegrationDestinationPolicy(connection, { itop: 'https://itop.example/team/' }).availability).toBe('configured')
  expect(applyIntegrationDestinationPolicy(connection, { itop: 'https://itop.example' }).availability).toBe('destination_blocked')
})
