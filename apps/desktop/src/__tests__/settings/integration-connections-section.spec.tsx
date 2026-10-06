// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { IntegrationConnection, IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins'
import { describeIntegrationConnection } from '@bitsentry-ce/core/features/plugins'
import type { PluginDescriptor } from '@bitsentry-ce/components/services/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

import { IntegrationConnectionsSection, type IntegrationConnectionsPort } from '@bitsentry-ce/components/settings/IntegrationConnectionsSection'

afterEach(cleanup)

/** A ticketing plugin that is not iTop: the form must be built from what the plugin declares. */
const ticketing: PluginDescriptor = {
  id: 'acme.tickets',
  name: 'Acme tickets',
  version: '1.0.0',
  description: 'Example ticketing plugin',
  metadata: {
    persistence: {
      configVersion: 3,
      destinationField: 'serviceUrl',
      configFields: [
        { key: 'serviceUrl', label: 'Service URL', type: 'string', required: true },
        { key: 'project', label: 'Project key', type: 'string', required: false },
      ],
      resources: [{ type: 'issue', stateVersion: 1, readActionId: 'read_issue' }],
      eventChannels: [],
    },
  },
  auth: {
    fields: [
      { key: 'apiToken', label: 'API token', type: 'string', required: false, secret: true },
      { key: 'username', label: 'User name', type: 'string', required: false },
    ],
  },
  actions: [],
}

const withoutPersistence: PluginDescriptor = { ...ticketing, id: 'acme.legacy', name: 'Acme legacy', metadata: {} }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function describeRows(rows: IntegrationConnectionInput[]): IntegrationConnection[] {
  return rows.map((row) => describeIntegrationConnection(row, ticketing as never))
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function choosePlugin() {
  fireEvent.change(screen.getByLabelText('settings.integrationConnections.plugin'), { target: { value: ticketing.id } })
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))
}

function createConnectionService() {
  const rows: IntegrationConnectionInput[] = []
  const service: IntegrationConnectionsPort = {
    list: async () => describeRows(rows),
    listPlugins: async () => [ticketing, withoutPersistence],
    save: async (connection) => {
      const index = rows.findIndex((row) => row.id === connection.id)
      if (index === -1) rows.push(connection)
      else rows[index] = connection
    },
    remove: async (id) => {
      const index = rows.findIndex((row) => row.id === id)
      if (index !== -1) rows.splice(index, 1)
    },
  }
  return { rows, service }
}

const storedConnection: IntegrationConnectionInput = {
  id: '33333333-3333-4333-8333-333333333333', name: 'Disabled', pluginId: ticketing.id, enabled: false,
  configVersion: 3, config: { serviceUrl: 'https://tickets.example/api', project: 'OPS' }, auth: { apiToken: 'stored-token' },
}

describe('IntegrationConnectionsSection', () => {
  it('offers only plugins that declare a connection contract', async () => {
    const { service } = createConnectionService()
    render(<IntegrationConnectionsSection service={service} />)

    await screen.findByRole('option', { name: 'Acme tickets' })
    expect(screen.queryByRole('option', { name: 'Acme legacy' })).toBeNull()
  })

  it('keeps a saved connection visible when the initial list request resolves late', async () => {
    const initialList = deferred<IntegrationConnection[]>()
    const saved: IntegrationConnectionInput[] = []
    let isInitialList = true
    const service: IntegrationConnectionsPort = {
      list: () => {
        if (isInitialList) {
          isInitialList = false
          return initialList.promise
        }
        return Promise.resolve(describeRows(saved))
      },
      listPlugins: async () => [ticketing],
      save: async (connection) => { saved.push(connection) },
      remove: async () => undefined,
    }

    render(<IntegrationConnectionsSection service={service} />)
    await screen.findByRole('option', { name: 'Acme tickets' })
    choosePlugin()
    fill('settings.integrationConnections.name', 'Production')
    fill('Service URL', 'https://tickets.example/api')
    save()

    expect(await screen.findByText('Production — https://tickets.example/api')).toBeTruthy()
    await act(async () => { initialList.resolve([]) })
    await waitFor(() => expect(screen.getByText('Production — https://tickets.example/api')).toBeTruthy())
  })

  it('saves provider settings apart from credentials, as the plugin versions them', async () => {
    const { rows, service } = createConnectionService()
    render(<IntegrationConnectionsSection service={service} />)
    await screen.findByRole('option', { name: 'Acme tickets' })
    choosePlugin()
    fill('settings.integrationConnections.name', 'Acme production')
    fill('Service URL', 'https://tickets.example/api')
    fill('Project key', 'OPS')
    fill('API token', 'private-token')
    save()

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]).toMatchObject({
      pluginId: ticketing.id, enabled: true, configVersion: 3,
      config: { serviceUrl: 'https://tickets.example/api', project: 'OPS' },
      auth: { apiToken: 'private-token' },
    })
    expect(rows[0]?.config).not.toHaveProperty('apiToken')
  })

  it('keeps a disabled connection disabled and sends no credential when only the name changes', async () => {
    const { rows, service } = createConnectionService()
    rows.push(storedConnection)
    render(<IntegrationConnectionsSection service={service} />)

    expect(await screen.findByText('Disabled — https://tickets.example/api')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationConnections.edit' }))
    expect(screen.getByLabelText('Project key')).toHaveProperty('value', 'OPS')
    fill('settings.integrationConnections.name', 'Renamed')
    save()

    await waitFor(() => expect(rows[0]?.name).toBe('Renamed'))
    expect(rows[0]?.enabled).toBe(false)
    // An empty credential is never sent; the host keeps what is stored.
    expect(rows[0]?.auth).toEqual({})
  })

  it('clears the edit form after deleting its connection so Save cannot recreate it', async () => {
    const { rows, service } = createConnectionService()
    rows.push({ ...storedConnection, enabled: true })
    render(<IntegrationConnectionsSection service={service} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationConnections.edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.remove' }))
    await waitFor(() => expect(rows).toHaveLength(0))

    choosePlugin()
    fill('settings.integrationConnections.name', 'Replacement')
    fill('Service URL', 'https://replacement.example/api')
    fill('API token', 'replacement-token')
    save()

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]?.id).not.toBe(storedConnection.id)
    expect(rows[0]?.name).toBe('Replacement')
  })
})
