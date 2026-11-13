// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IntegrationConnection, IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins'
import { describeIntegrationConnection } from '@bitsentry-ce/core/features/plugins'
import type { PluginDescriptor } from '@bitsentry-ce/components/services/contracts'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, string>) => (values?.field === undefined ? key : `${key}:${values.field}`),
}))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

import { IntegrationConnectionsPanel, type IntegrationConnectionsPort } from '@bitsentry-ce/components/integrations/IntegrationConnectionsPanel'

beforeAll(() => {
  // Radix Select needs pointer capture and scrolling, which jsdom does not provide.
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined })
})

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
        { key: 'mapping', label: 'Field mapping', type: 'json', required: false },
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

/** A plugin that accepts either a token or a username and password, declared as alternative credential sets. */
const helpdesk: PluginDescriptor = {
  ...ticketing,
  id: 'acme.helpdesk',
  name: 'Acme helpdesk',
  auth: {
    requiredSets: [['token'], ['login', 'secret']],
    fields: [
      { key: 'legacyUrl', label: 'Legacy URL', type: 'string', required: false },
      { key: 'token', label: 'Token', type: 'string', required: false, secret: true },
      { key: 'login', label: 'Login', type: 'string', required: false },
      { key: 'secret', label: 'Secret', type: 'string', required: false, secret: true },
    ],
  },
}

const withoutPersistence: PluginDescriptor = { ...ticketing, id: 'acme.legacy', name: 'Acme legacy', metadata: {} }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail })
  return { promise, resolve, reject }
}

function describeRows(rows: IntegrationConnectionInput[]): IntegrationConnection[] {
  return rows.map((row) => describeIntegrationConnection(row, ticketing as never))
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))
}

async function choose(label: string, option: string) {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText(label))
  await user.click(await screen.findByRole('option', { name: option }))
}

function createConnectionService(plugins: PluginDescriptor[] = [ticketing, withoutPersistence]) {
  const rows: IntegrationConnectionInput[] = []
  const service: IntegrationConnectionsPort = {
    list: async () => describeRows(rows),
    listPlugins: async () => plugins,
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

describe('IntegrationConnectionsPanel', () => {
  it('shows a loading state, then the form for the first eligible plugin', async () => {
    const plugins = deferred<PluginDescriptor[]>()
    const { service } = createConnectionService()
    render(<IntegrationConnectionsPanel service={{ ...service, listPlugins: () => plugins.promise }} />)

    expect(screen.getByRole('status').textContent).toBe('settings.integrationConnections.loading')
    expect(screen.queryByRole('button', { name: 'settings.integrationConnections.save' })).toBeNull()
    await act(async () => { plugins.resolve([ticketing]) })

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByLabelText('settings.integrationConnections.plugin').textContent).toBe('Acme tickets')
    expect((screen.getByRole('button', { name: 'settings.integrationConnections.save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('explains an empty plugin list and shows the host next step instead of a blank form', async () => {
    const { service } = createConnectionService([withoutPersistence])
    render(<IntegrationConnectionsPanel service={service} emptyAction={<a href="/app-settings#plugins">Open plugins</a>} />)

    expect(await screen.findByText('settings.integrationConnections.noPlugins')).toBeTruthy()
    expect(screen.getByText('settings.integrationConnections.noPluginsHint')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open plugins' }).getAttribute('href')).toBe('/app-settings#plugins')
    expect(screen.queryByLabelText('settings.integrationConnections.plugin')).toBeNull()
    expect(screen.queryByRole('button', { name: 'settings.integrationConnections.save' })).toBeNull()
  })

  it('reports a failed plugin load and recovers on retry', async () => {
    let attempts = 0
    const { service } = createConnectionService()
    render(<IntegrationConnectionsPanel service={{
      ...service,
      listPlugins: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('offline')
        return [ticketing]
      },
    }} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('settings.integrationConnections.loadFailed')
    expect(screen.queryByLabelText('settings.integrationConnections.plugin')).toBeNull()
    fireEvent.click(within(alert).getByRole('button', { name: 'settings.integrationConnections.retry' }))

    expect(await screen.findByLabelText('settings.integrationConnections.plugin')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers only plugins that declare a connection contract', async () => {
    const { service } = createConnectionService([ticketing, withoutPersistence, helpdesk])
    render(<IntegrationConnectionsPanel service={service} />)
    await screen.findByLabelText('settings.integrationConnections.plugin')

    await userEvent.setup().click(screen.getByLabelText('settings.integrationConnections.plugin'))
    expect(await screen.findByRole('option', { name: 'Acme tickets' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Acme helpdesk' })).toBeTruthy()
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

    render(<IntegrationConnectionsPanel service={service} />)
    await screen.findByLabelText('Service URL')
    fill('settings.integrationConnections.name', 'Production')
    fill('Service URL', 'https://tickets.example/api')
    save()

    expect(await screen.findByText('— https://tickets.example/api')).toBeTruthy()
    await act(async () => { initialList.resolve([]) })
    await waitFor(() => expect(screen.getByText('— https://tickets.example/api')).toBeTruthy())
  })

  it('builds the form from the plugin contract and saves settings apart from credentials', async () => {
    const { rows, service } = createConnectionService()
    render(<IntegrationConnectionsPanel service={service} />)
    await screen.findByLabelText('Service URL')

    expect(screen.getByLabelText('Field mapping').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('API token').getAttribute('type')).toBe('password')
    fill('settings.integrationConnections.name', 'Acme production')
    fill('Service URL', 'https://tickets.example/api')
    fill('Project key', 'OPS')
    fill('Field mapping', '{"priority":"P1"}')
    fill('API token', 'private-token')
    save()

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]).toMatchObject({
      pluginId: ticketing.id, enabled: true, configVersion: 3,
      config: { serviceUrl: 'https://tickets.example/api', project: 'OPS', mapping: { priority: 'P1' } },
      auth: { apiToken: 'private-token' },
    })
    expect(rows[0]?.config).not.toHaveProperty('apiToken')
  })

  it('refuses a JSON field that does not parse and names it', async () => {
    const { rows, service } = createConnectionService()
    render(<IntegrationConnectionsPanel service={service} />)
    await screen.findByLabelText('Service URL')
    fill('settings.integrationConnections.name', 'Acme production')
    fill('Service URL', 'https://tickets.example/api')
    fill('Field mapping', '{not json')
    save()

    expect((await screen.findByRole('alert')).textContent).toBe('settings.integrationConnections.invalidJson:Field mapping')
    expect(rows).toHaveLength(0)
  })

  it('offers each declared credential set and sends only the chosen one', async () => {
    const { rows, service } = createConnectionService([helpdesk])
    render(<IntegrationConnectionsPanel service={service} />)
    await screen.findByLabelText('Token')

    expect(screen.queryByLabelText('Legacy URL')).toBeNull()
    expect(screen.queryByLabelText('Login')).toBeNull()
    await choose('settings.integrationConnections.authMethod', 'Login + Secret')
    expect(screen.queryByLabelText('Token')).toBeNull()

    fill('settings.integrationConnections.name', 'Helpdesk')
    fill('Service URL', 'https://helpdesk.example/api')
    fill('Login', 'ops')
    fill('Secret', 'private-secret')
    save()

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]?.auth).toEqual({ login: 'ops', secret: 'private-secret' })
  })

  it('shows each connection status and keeps a disabled connection disabled without resending credentials', async () => {
    const { rows, service } = createConnectionService()
    rows.push(storedConnection, { ...storedConnection, id: '44444444-4444-4444-8444-444444444444', name: 'Live', enabled: true })
    render(<IntegrationConnectionsPanel service={service} />)

    const disabledRow = (await screen.findByText('Disabled')).closest('li') as HTMLElement
    const liveRow = screen.getByText('Live').closest('li') as HTMLElement
    expect(within(disabledRow).getByText('settings.integrationConnections.inactive')).toBeTruthy()
    expect(within(liveRow).getByText('settings.integrationConnections.active')).toBeTruthy()

    fireEvent.click(within(disabledRow).getByRole('button', { name: 'settings.integrationConnections.edit' }))
    expect(screen.getByLabelText('Project key')).toHaveProperty('value', 'OPS')
    expect((screen.getByLabelText('Service URL') as HTMLInputElement).disabled).toBe(true)
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
    render(<IntegrationConnectionsPanel service={service} />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.integrationConnections.edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.remove' }))
    await waitFor(() => expect(rows).toHaveLength(0))

    fill('settings.integrationConnections.name', 'Replacement')
    fill('Service URL', 'https://replacement.example/api')
    fill('API token', 'replacement-token')
    save()

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]?.id).not.toBe(storedConnection.id)
    expect(rows[0]?.name).toBe('Replacement')
  })

  it('opens a deep-linked connection once and reports when editing ends', async () => {
    const { rows, service } = createConnectionService()
    rows.push({ ...storedConnection, enabled: true })
    const onEditConnectionChange = vi.fn()
    render(<IntegrationConnectionsPanel service={service} editConnectionId={storedConnection.id} onEditConnectionChange={onEditConnectionChange} />)

    await waitFor(() => expect(screen.getByLabelText('settings.integrationConnections.name')).toHaveProperty('value', 'Disabled'))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.cancel' }))

    expect(onEditConnectionChange).toHaveBeenLastCalledWith(null)
    expect(screen.getByLabelText('settings.integrationConnections.name')).toHaveProperty('value', '')
  })
})
