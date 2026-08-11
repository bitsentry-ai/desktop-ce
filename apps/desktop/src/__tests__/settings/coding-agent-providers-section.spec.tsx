// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCatalogModelIds } from '@bitsentry-ce/components/llm/modelCatalog'

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  listModels: vi.fn(),
  saveProvider: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('@bitsentry-ce/components/services/desktop-api', () => ({
  getDesktopApi: () => ({
    llm: {
      getProviders: mocks.getProviders,
      saveProvider: mocks.saveProvider,
      local: {
        getSettings: mocks.getSettings,
        saveSettings: mocks.saveSettings,
        detectBinary: vi.fn(),
        probe: vi.fn(),
        listModels: mocks.listModels,
      },
    },
  }),
}))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@bitsentry-ce/components/hooks/useDebouncedAutoSave', () => ({
  useDebouncedAutoSave: () => ({ status: 'idle', error: null }),
}))

import {
  CodingAgentProvidersSection,
} from '@bitsentry-ce/components/settings/CodingAgentProvidersSection'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  mocks.getSettings.mockResolvedValue({
    claudeCode: { enabled: true, binaryPath: 'claude' },
    codex: { enabled: true, binaryPath: 'codex', codexArgs: [] },
    opencode: { enabled: true, binaryPath: 'opencode', opencodeArgs: [] },
    cursor: { enabled: true, binaryPath: 'cursor-agent' },
  })
  mocks.getProviders.mockResolvedValue({
    opencode: {
      model: 'opencode/big-pickle-v2',
      availableModels: [],
    },
  })
  mocks.listModels.mockReset()
  mocks.saveProvider.mockResolvedValue({ ok: true })
  mocks.saveSettings.mockResolvedValue({ ok: true })
})

describe('CodingAgentProvidersSection', () => {
  it('falls back to the current OpenCode model when discovery fails', async () => {
    const captureRendererException = vi.fn()
    mocks.listModels.mockRejectedValue(new Error('OpenCode model probe failed'))

    render(
      <CodingAgentProvidersSection
        primaryAgent={null}
        isPrimarySelectionPending={false}
        onSetPrimaryAgent={vi.fn()}
        captureRendererException={captureRendererException}
      />,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /OpenCode/ })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: /OpenCode/ }))
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveProperty(
        'value',
        'opencode/big-pickle-v2',
      )
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'common.lLMProviderSettingsPanel.syncModels',
      }),
    )

    await waitFor(() => {
      const saveCall = mocks.saveProvider.mock.calls.find(
        ([provider]) => provider === 'opencode',
      )
      expect(saveCall).toBeDefined()
      const availableModels = saveCall?.[1].availableModels as string[]
      expect(availableModels).toEqual(
        expect.arrayContaining(getCatalogModelIds('opencode')),
      )
      expect(availableModels).toContain('opencode/big-pickle-v2')
    })
    expect(screen.getByText('OpenCode model probe failed')).toBeTruthy()
    expect(captureRendererException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ provider: 'opencode', operation: 'listModels' }),
    )
  })
})
