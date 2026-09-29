import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  INTEGRATION_CONNECTIONS_STORE_KEY,
  INTEGRATION_OPERATIONS_STORE_KEY,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthStore,
} from '../src/features/plugins'
import { createDesktopPluginHandlers } from '../src/features/plugins/desktop-plugin.handlers'
import { createDesktopNodePluginRuntimeService } from '../src/features/plugins/node'

const connectionId = '11111111-1111-4111-8111-111111111111'

function memoryAuthStore(): DesktopPluginStoredAuthStore & { records: Map<string, DesktopPluginStoredAuthRecord> } {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return {
    records,
    get: async (id) => records.get(id) ?? {},
    set: async (id, value) => { records.set(id, value); return value },
    clear: async (id) => { records.delete(id) },
  }
}

// A minimal iTop plugin with one read action, installed through the public artifact path.
const itopArtifact = Buffer.from(`
exports.plugin = {
  id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets fixture.', auth: { fields: [] },
  actions: [{ id: 'get_object', title: 'Read', description: 'Read', riskLevel: 'read', fields: [],
    execute() { return { ok: true, status: 200, summary: 'read', data: { ok: true } } } }],
}
`, 'utf-8').toString('base64')

describe('stored integration connections', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'bitsentry-connections-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  async function setup() {
    const authStore = memoryAuthStore()
    const service = createDesktopNodePluginRuntimeService([path.join(root, 'plugins')], authStore)
    await service.installFromArtifact({ artifactBase64: itopArtifact })
    const save = (baseUrl: string, authToken: string) => service.saveIntegrationConnection({
      id: connectionId, name: 'Itop Bitsentry', pluginId: 'itop', enabled: true, auth: { baseUrl, authToken },
    })
    const current = async () => {
      const [connection] = await service.listIntegrationConnections()
      if (connection === undefined) throw new Error('No connection stored')
      return connection
    }
    const read = (expected: { target: string; revision?: string }) => service.executeIntegrationAction(
      { connectionId, actionId: 'get_object', input: {} }, undefined, { requiredRiskLevel: 'read', expectedConnection: expected },
    )
    return { authStore, service, save, current, read }
  }

  it('gives a connection a new revision on every save, including a credential-only edit', async () => {
    const { save, current } = await setup()

    await save('https://itop.example', 'first-token')
    const first = (await current()).revision
    await save('https://itop.example', 'second-token')
    const second = (await current()).revision

    expect(first).toEqual(expect.any(String))
    expect(second).toEqual(expect.any(String))
    expect(second).not.toBe(first)
  })

  it('runs a read on the connection snapshot the tool saw', async () => {
    const { save, current, read } = await setup()
    await save('https://itop.example', 'first-token')
    const { target, revision } = await current()

    await expect(read({ target, revision })).resolves.toMatchObject({ ok: true })
  })

  it.each([
    ['its credentials were edited on the same target', 'https://itop.example', 'second-token'],
    ['it now points at another endpoint', 'https://other.example', 'first-token'],
  ])('refuses a read when the connection changed after the tool listed it (%s)', async (_label, baseUrl, authToken) => {
    const { save, current, read } = await setup()
    await save('https://itop.example', 'first-token')
    const { target, revision } = await current()
    await save(baseUrl, authToken)

    await expect(read({ target, revision })).rejects.toThrow('Connection changed. Retry the read.')
  })
})

describe('plugin credential handlers', () => {
  it.each([
    ['plugins:getStoredAuth', {}],
    ['plugins:updateStoredAuth', { auth: { anything: 'value' } }],
    ['plugins:clearStoredAuth', {}],
  ])('%s cannot reach the internal connection and proposal records', async (channel, extra) => {
    const authStore = memoryAuthStore()
    const service = createDesktopNodePluginRuntimeService([], authStore)
    const handlers = createDesktopPluginHandlers(service, authStore)
    authStore.records.set(INTEGRATION_CONNECTIONS_STORE_KEY, { connections: '[]' })
    authStore.records.set(INTEGRATION_OPERATIONS_STORE_KEY, { operations: '[{"kept":true}]' })

    for (const pluginId of [INTEGRATION_OPERATIONS_STORE_KEY, INTEGRATION_CONNECTIONS_STORE_KEY, ` ${INTEGRATION_OPERATIONS_STORE_KEY} `]) {
      // Some handlers throw before returning a promise; both count as a refusal.
      await expect((async () => handlers[channel]?.({ pluginId, ...extra }))()).rejects.toThrow('reserved')
    }

    expect(authStore.records.get(INTEGRATION_OPERATIONS_STORE_KEY)).toEqual({ operations: '[{"kept":true}]' })
    expect(authStore.records.get(INTEGRATION_CONNECTIONS_STORE_KEY)).toEqual({ connections: '[]' })
  })

  it('still clears the credentials of an ordinary plugin', async () => {
    const authStore = memoryAuthStore()
    const handlers = createDesktopPluginHandlers(createDesktopNodePluginRuntimeService([], authStore), authStore)
    authStore.records.set('sentry', { token: 'value' })

    await expect(handlers['plugins:clearStoredAuth']?.({ pluginId: 'sentry' })).resolves.toEqual({ success: true })

    expect(authStore.records.has('sentry')).toBe(false)
  })
})
