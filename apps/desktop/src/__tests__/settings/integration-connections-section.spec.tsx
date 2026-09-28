// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { IntegrationConnection, IntegrationConnectionInput } from '@bitsentry-ce/core/features/plugins'
import { describeIntegrationConnection } from '@bitsentry-ce/core/features/plugins'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ t: (key: string) => key }))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: mocks.t }),
}))

import { IntegrationConnectionsSection, type IntegrationConnectionsPort } from '@bitsentry-ce/components/settings/IntegrationConnectionsSection'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function describeRows(rows: IntegrationConnectionInput[]): IntegrationConnection[] {
  return rows.map((row) => describeIntegrationConnection(row))
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function createConnectionService() {
  const rows: IntegrationConnectionInput[] = []
  const service: IntegrationConnectionsPort = {
    list: async () => describeRows(rows),
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

describe('IntegrationConnectionsSection', () => {
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
      save: async (connection) => { saved.push(connection) },
      remove: async (id) => {
        const index = saved.findIndex((row) => row.id === id)
        if (index !== -1) saved.splice(index, 1)
      },
    }

    render(<IntegrationConnectionsSection service={service} />)
    fill('settings.integrationConnections.name', 'Production')
    fill('settings.integrationConnections.endpoint', 'https://itop.example')
    fill('settings.integrationConnections.token', 'production-secret')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    expect(await screen.findByText('Production — https://itop.example/')).toBeTruthy()
    await act(async () => { initialList.resolve([]) })
    await waitFor(() => expect(screen.getByText('Production — https://itop.example/')).toBeTruthy())
  })

  it('creates and edits an iTop username/password connection in that auth mode', async () => {
    const { rows, service } = createConnectionService()
    render(<IntegrationConnectionsSection service={service} />)
    fill('settings.integrationConnections.name', 'Sandbox')
    fill('settings.integrationConnections.endpoint', 'https://itop.example')
    fireEvent.change(screen.getByLabelText('settings.integrationConnections.authMethod'), {
      target: { value: 'username_password' },
    })
    fill('settings.integrationConnections.username', 'sandbox-user')
    fill('settings.integrationConnections.password', 'first-password')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    expect(await screen.findByText('Sandbox — https://itop.example/')).toBeTruthy()
    expect(rows[0]).toMatchObject({ auth: { baseUrl: 'https://itop.example', username: 'sandbox-user', password: 'first-password' } })
    expect(rows[0]?.auth).not.toHaveProperty('authToken')

    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.edit' }))
    expect(screen.getByLabelText('settings.integrationConnections.authMethod')).toHaveProperty('value', 'username_password')
    fill('settings.integrationConnections.username', 'sandbox-user-updated')
    fill('settings.integrationConnections.password', 'updated-password')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    await waitFor(() => expect(rows[0]?.auth.password).toBe('updated-password'))
    expect(rows[0]?.auth).toMatchObject({ username: 'sandbox-user-updated', baseUrl: 'https://itop.example/' })
    expect(rows[0]?.auth).not.toHaveProperty('authToken')
  })

  it('creates and edits an iTop token connection without changing its auth mode', async () => {
    const { rows, service } = createConnectionService()
    render(<IntegrationConnectionsSection service={service} />)
    fill('settings.integrationConnections.name', 'Token iTop')
    fill('settings.integrationConnections.endpoint', 'https://token.itop.example')
    fill('settings.integrationConnections.token', 'initial-token')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))
    expect(await screen.findByText('Token iTop — https://token.itop.example/')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.edit' }))
    expect(screen.getByLabelText('settings.integrationConnections.authMethod')).toHaveProperty('value', 'token')
    fill('settings.integrationConnections.token', 'updated-token')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    await waitFor(() => expect(rows[0]?.auth.authToken).toBe('updated-token'))
    expect(rows[0]?.auth).toMatchObject({ baseUrl: 'https://token.itop.example/' })
    expect(rows[0]?.auth).not.toHaveProperty('username')
  })

  it('keeps a disabled connection disabled when saving edits', async () => {
    const { rows, service } = createConnectionService()
    rows.push({
      id: '33333333-3333-4333-8333-333333333333', name: 'Disabled', pluginId: 'itop', enabled: false,
      auth: { baseUrl: 'https://disabled.itop.example', authToken: 'old-token' },
    })
    render(<IntegrationConnectionsSection service={service} />)

    expect(await screen.findByText('Disabled — https://disabled.itop.example/')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.edit' }))
    fill('settings.integrationConnections.token', 'updated-token')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    await waitFor(() => expect(rows[0]?.auth.authToken).toBe('updated-token'))
    expect(rows[0]?.enabled).toBe(false)
  })

  it('clears the edit form after deleting its connection so Save cannot recreate it', async () => {
    const { rows, service } = createConnectionService()
    const deletedId = '44444444-4444-4444-8444-444444444444'
    rows.push({
      id: deletedId, name: 'To delete', pluginId: 'itop', enabled: true,
      auth: { baseUrl: 'https://delete.itop.example', authToken: 'old-token' },
    })
    render(<IntegrationConnectionsSection service={service} />)

    expect(await screen.findByText('To delete — https://delete.itop.example/')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.remove' }))
    await waitFor(() => expect(rows).toHaveLength(0))

    fill('settings.integrationConnections.name', 'Replacement')
    fill('settings.integrationConnections.endpoint', 'https://replacement.itop.example')
    fill('settings.integrationConnections.token', 'replacement-token')
    fireEvent.click(screen.getByRole('button', { name: 'settings.integrationConnections.save' }))

    await waitFor(() => expect(rows).toHaveLength(1))
    expect(rows[0]?.id).not.toBe(deletedId)
    expect(rows[0]?.name).toBe('Replacement')
  })
})
