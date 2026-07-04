import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@bitsentry-ce/i18n'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { createRoot } from 'react-dom/client'
import { useEffect } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { BitsentryServicesProvider } from '../services'
import type { BitsentryServicePorts } from '../services/contracts'
import { ThemeProvider } from '../theme'

const E2E_ENABLED_STORAGE_KEY = 'bitsentry.e2e.enabled'
const E2E_INITIAL_ROUTE_STORAGE_KEY = 'bitsentry.e2e.initialRoute'

function readInitialRoute(): string {
  if (typeof window === 'undefined') return '/'

  try {
    if (window.localStorage.getItem(E2E_ENABLED_STORAGE_KEY) !== 'true') {
      return '/'
    }

    const route = window.localStorage.getItem(E2E_INITIAL_ROUTE_STORAGE_KEY)
    if (route === null || !route.startsWith('/') || route.startsWith('//')) return '/'

    return route
  } catch {
    return '/'
  }
}

function DesktopRouteUrlSync(): null {
  const location = useLocation()

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return

    const nextPath = `${location.pathname}${location.search}${location.hash}`
    const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (nextPath !== currentPath) {
      window.history.replaceState(null, '', nextPath)
    }
  }, [location.hash, location.pathname, location.search])

  return null
}

export async function renderDesktopRendererEntry(options: {
  App: ComponentType
  DesktopStateBootstrap: ComponentType<{ children: ReactNode }>
  services: BitsentryServicePorts
  initDesktopAnalytics: () => void
  initSentryRenderer: () => Promise<unknown>
}): Promise<void> {
  const {
    App,
    DesktopStateBootstrap,
    services,
    initDesktopAnalytics,
    initSentryRenderer,
  } = options

  // Initialize Sentry before first render so startup crashes are captured.
  await initSentryRenderer()
  initDesktopAnalytics()

  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  const queryClient = new QueryClient()

  root.render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <BitsentryServicesProvider services={services}>
            <MemoryRouter initialEntries={[readInitialRoute()]}>
              <DesktopRouteUrlSync />
              <DesktopStateBootstrap>
                <App />
              </DesktopStateBootstrap>
            </MemoryRouter>
          </BitsentryServicesProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>,
  )
}
