// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@bitsentry-ce/components/layout/DashboardLayout', () => ({
  default: ({ children }: { children: ReactNode }) => createElement('main', null, children),
}))

function stubSection(id: string) {
  return () => createElement('section', { id, 'data-testid': `section-${id}` }, id)
}

vi.mock('@bitsentry-ce/components/settings/AppearanceSettingsSection', () => ({
  AppearanceSettingsSection: () => createElement('div', { 'data-testid': 'appearance-rows' }),
}))
vi.mock('@bitsentry-ce/components/settings/UpdateSettingsSection', () => ({
  UpdateSettingsSection: () => null,
}))
vi.mock('@bitsentry-ce/components/settings/PluginsSettingsSection', () => ({
  PluginsSettingsSection: stubSection('plugins'),
}))
vi.mock('@bitsentry-ce/components/settings/GlobalVariablesSettingsSection', () => ({
  GlobalVariablesSettingsSection: stubSection('global-variables'),
}))
vi.mock('@bitsentry-ce/components/settings/CodingAgentProvidersSection', () => ({
  CodingAgentProvidersSection: stubSection('coding-agents'),
}))
vi.mock('@bitsentry-ce/components/settings/TelemetrySection', () => ({
  TelemetrySection: stubSection('telemetry'),
}))
vi.mock('@bitsentry-ce/components/tutorial/HelpSection', () => ({
  HelpSection: () => createElement('div', { 'data-testid': 'help-tours' }),
}))
vi.mock('@bitsentry-ce/components/shortcuts', () => ({
  defaultNavigationCommands: () => [],
  KeyboardShortcutsList: () => createElement('div', { 'data-testid': 'shortcut-list' }),
}))
vi.mock('@bitsentry-ce/components/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

import { DesktopAppSettingsScaffold } from '@bitsentry-ce/components/desktop/DesktopAppSettingsScaffold'

function LocationProbe() {
  const location = useLocation()
  return createElement('output', { 'data-testid': 'location' }, `${location.pathname}${location.hash}`)
}

function renderSettings(initialEntry: string, props: { withExtras?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <DesktopAppSettingsScaffold
        primaryAgent={null}
        isPrimarySelectionPending={false}
        onSetPrimaryAgent={vi.fn()}
        helpSectionTourMarker="settings-help"
        appSettingsExtraSections={
          props.withExtras === true
            ? [{ labelKey: 'navigation.navbar.llmProviders', hash: 'llm-providers' }]
            : undefined
        }
        additionalSections={
          props.withExtras === true
            ? createElement('section', { id: 'llm-providers', 'data-testid': 'section-llm-providers' })
            : undefined
        }
      />
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
})

describe('DesktopAppSettingsScaffold sections', () => {
  it('shows only Appearance when there is no hash', () => {
    renderSettings('/app-settings')

    expect(screen.getByTestId('appearance-rows')).toBeTruthy()
    expect(screen.queryByTestId('section-plugins')).toBeNull()
    expect(screen.queryByTestId('section-coding-agents')).toBeNull()
  })

  it('shows the section the hash names, so sidebar links still land on it', () => {
    renderSettings('/app-settings#global-variables')

    expect(screen.getByTestId('section-global-variables')).toBeTruthy()
    expect(screen.queryByTestId('appearance-rows')).toBeNull()
    const current = screen
      .getAllByRole('link')
      .find((link) => link.getAttribute('aria-current') === 'page')
    expect(current?.getAttribute('href')).toBe('/app-settings#global-variables')
  })

  it('switches sections from the list and the narrow-screen picker through the hash', () => {
    renderSettings('/app-settings')

    fireEvent.click(screen.getByRole('link', { name: 'navigation.navbar.plugins' }))
    expect(screen.getByTestId('location').textContent).toBe('/app-settings#plugins')
    expect(screen.getByTestId('section-plugins')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('settings.sectionNav.label'), {
      target: { value: 'danger-zone' },
    })
    expect(screen.getByTestId('location').textContent).toBe('/app-settings#danger-zone')
    expect(screen.getByRole('button', { name: 'settings.appSettings.resetDatabase' })).toBeTruthy()
  })

  it('titles the page once, above the section list, with the section title under it', () => {
    renderSettings('/app-settings#danger-zone')

    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual([
      'settings.appSettings.settings',
    ])
    expect(screen.getByRole('heading', { level: 2, name: 'settings.appSettings.dangerZone' })).toBeTruthy()
  })

  it('keeps the help tour marker and shows host sections under their own hash', () => {
    const { unmount } = renderSettings('/app-settings#help')
    expect(document.querySelector('[data-tour="settings-help"]')).not.toBeNull()
    expect(screen.getByTestId('help-tours')).toBeTruthy()
    unmount()

    renderSettings('/app-settings#llm-providers', { withExtras: true })
    expect(screen.getByTestId('section-llm-providers')).toBeTruthy()
    expect(screen.queryByTestId('section-coding-agents')).toBeNull()
  })
})
