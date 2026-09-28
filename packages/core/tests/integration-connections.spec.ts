import { describe, expect, it } from 'vitest'
import { IntegrationConnectionStore } from '../src/features/plugins/integration-connection-store'
import { describeIntegrationConnection, validateIntegrationConnection } from '../src/features/plugins/integration-connections'
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
  it('preserves concurrent saves from separate store instances that share credentials', async () => {
    const backing = credentials()
    const firstStore = new IntegrationConnectionStore(backing)
    const secondStore = new IntegrationConnectionStore(backing)
    await Promise.all([firstStore.save(first), secondStore.save(second)])
    const reloadedStore = new IntegrationConnectionStore(backing)
    const reloaded = await reloadedStore.list()
    expect(reloaded.find((row) => row.id === first.id)?.auth.authToken).toBe('production-secret')
    expect(reloaded.find((row) => row.id === second.id)?.auth.authToken).toBe('staging-secret')
    await firstStore.remove(first.id)
    expect(await reloadedStore.list()).toEqual([second])
  })

  it('does not return credentials or misrepresent a missing plugin as configured', () => {
    const descriptor = describeIntegrationConnection(first)
    expect(descriptor.availability).toBe('plugin_unavailable')
    expect(descriptor.target).toBe('https://itop.example/team')
    expect(JSON.stringify(descriptor)).not.toContain('production-secret')
    expect(descriptor).not.toHaveProperty('auth')
  })

  it('describes username/password auth without exposing either credential', () => {
    const basicAuthConnection = {
      ...first,
      auth: { baseUrl: 'https://itop.example', username: 'sandbox-user', password: 'sandbox-password' },
    }
    expect(validateIntegrationConnection(basicAuthConnection)).toEqual(basicAuthConnection)
    const descriptor = describeIntegrationConnection(basicAuthConnection)
    expect(descriptor.authMode).toBe('username_password')
    expect(JSON.stringify(descriptor)).not.toContain('sandbox-user')
    expect(JSON.stringify(descriptor)).not.toContain('sandbox-password')
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
