// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginDescriptor } from '@bitsentry-ce/components/services/contracts'

vi.hoisted(() => {
  // The navbar decides at import time whether it runs in Desktop.
  ;(window as { bitsentry?: unknown }).bitsentry = {}
})

vi.mock('@bitsentry-ce/i18n', () => ({
  useFormatters: () => ({ relativeTime: (value: string) => value }),
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@bitsentry-ce/components/integrations/DataSourcesManager', () => ({
  default: () => <div>plugin management</div>,
}))

import Navbar from '@bitsentry-ce/components/layout/Navbar'
import DesktopIntegrationsPage from '@bitsentry-ce/components/desktop/DesktopIntegrationsPage'
import { PluginsSettingsSection } from '@bitsentry-ce/components/settings/PluginsSettingsSection'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'

afterEach(cleanup)

const itopLike: PluginDescriptor = {
  id: 'acme.tickets', name: 'Acme tickets', version: '1.0.0', description: '',
  metadata: { persistence: { configVersion: 1, destinationField: 'endpoint', configFields: [{ key: 'endpoint', label: 'Instance URL', type: 'string', required: true }], resources: [], eventChannels: [] } },
  auth: { fields: [{ key: 'token', label: 'Token', type: 'string', required: true, secret: true }] },
  actions: [],
}

function services(plugins: PluginDescriptor[]) {
  return {
    runtime: {
      getAuthSession: () => ({ user: { id: 1, email: 'qa@example.com' }, isAuthenticated: true, isLoading: false }),
      logout: vi.fn(), navigate: vi.fn(), getConnectionStatus: () => true,
    },
    runbooks: {} as never,
    incidents: { listThreads: vi.fn(async () => ({ threads: [], total: 0 })) },
    plugins: {
      list: vi.fn(async () => plugins),
      listConnections: vi.fn(async () => []),
      saveConnection: vi.fn(async () => undefined),
      removeConnection: vi.fn(async () => undefined),
    },
  } as never
}

function renderAt(path: string, element: React.ReactNode, plugins: PluginDescriptor[] = []) {
  return render(
    <BitsentryServicesProvider services={services(plugins)}>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </BitsentryServicesProvider>,
  )
}

describe('Desktop Integrations page', () => {
  it('is a top-level navbar entry in Desktop', () => {
    renderAt('/incidents', <Navbar />)

    const link = screen.getByRole('link', { name: 'navigation.navbar.integrations' })
    expect(link.getAttribute('href')).toBe('/integrations')
  })

  it('manages connections through the local plugin services', async () => {
    renderAt('/integrations', <DesktopIntegrationsPage />, [itopLike])

    expect(await screen.findByLabelText('Instance URL')).toBeTruthy()
    expect(screen.getByLabelText('settings.integrationConnections.plugin').textContent).toBe('Acme tickets')
  })

  it('points to plugin settings when no installed plugin supports connections', async () => {
    renderAt('/integrations', <DesktopIntegrationsPage />)

    expect(await screen.findByText('settings.integrationConnections.noPlugins')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'settings.integrationConnections.openPlugins' }).getAttribute('href')).toBe('/app-settings#plugins')
  })

  it('leaves only plugin management in Settings', () => {
    renderAt('/app-settings', <PluginsSettingsSection />, [itopLike])

    expect(screen.getByText('plugin management')).toBeTruthy()
    expect(screen.queryByText('settings.integrationConnections.title')).toBeNull()
  })
})
