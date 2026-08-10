// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '@bitsentry-ce/components/chat/ModelPicker'
import type { SavedProviderConfig } from '@bitsentry-ce/components/chat/types'
import {
  clearDiscoveredModels,
  getProviderModelOptionsWithDiscovery,
  useDiscoveredModels,
} from '@bitsentry-ce/components/llm/modelDiscovery'
import { resolveSyncedModelId } from '@bitsentry-ce/components/investigation/provider-selection'

const mocks = vi.hoisted(() => ({
  getDesktopApi: vi.fn(),
  listModels: vi.fn(),
}))

vi.mock('../../../../packages/components/src/services/desktop-api', () => ({
  getDesktopApi: mocks.getDesktopApi,
}))

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'common.modelPicker.modelsUnavailable': 'Unable to load models',
      'common.modelPicker.noModelsFound': 'No models found',
      'common.modelPicker.searchModels': 'Search models...',
      'common.modelPicker.addToFavorites': 'Add to favorites',
      'common.modelPicker.removeFromFavorites': 'Remove from favorites',
      'common.incidents.selectModel': 'Select model',
    }[key] ?? key),
  }),
}))

function createProviderConfig(overrides: Partial<SavedProviderConfig> = {}): SavedProviderConfig {
  return {
    hasApiKey: true,
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-7',
    availableModels: [],
    isSelectable: true,
    isPrimary: true,
    ...overrides,
  }
}

function renderPicker(config: SavedProviderConfig = createProviderConfig()): void {
  mocks.getDesktopApi.mockReturnValue({
    llm: { listModels: mocks.listModels },
  })
  render(
    <ModelPicker
      selectedProviderKey="anthropic"
      selectedModelId="claude-opus-4-7"
      onSelectProvider={vi.fn()}
      onSelectModel={vi.fn()}
      configuredProviderKeys={["anthropic"]}
      providerConfigs={{ anthropic: config }}
    />,
  )
  fireEvent.click(screen.getByRole('button'))
}

function SelectionHarness() {
  const [selectedModelId, setSelectedModelId] = useState('claude-opus-4-7')
  const discoveredModels = useDiscoveredModels()
  const providerConfigs = { anthropic: createProviderConfig() }

  useEffect(() => {
    const options = getProviderModelOptionsWithDiscovery(
      'anthropic',
      providerConfigs,
      discoveredModels,
    )
    const nextModelId = resolveSyncedModelId(
      'anthropic',
      'anthropic',
      selectedModelId,
      providerConfigs.anthropic.model,
      options,
    )
    if (nextModelId !== selectedModelId) setSelectedModelId(nextModelId)
  }, [discoveredModels, selectedModelId])

  return (
    <ModelPicker
      selectedProviderKey="anthropic"
      selectedModelId={selectedModelId}
      onSelectProvider={vi.fn()}
      onSelectModel={setSelectedModelId}
      onSelectModelSelection={(_, modelId) => { setSelectedModelId(modelId) }}
      configuredProviderKeys={["anthropic"]}
      providerConfigs={providerConfigs}
    />
  )
}

describe('ModelPicker live API models', () => {
  afterEach(() => {
    cleanup()
    clearDiscoveredModels('anthropic')
    mocks.getDesktopApi.mockReset()
    mocks.listModels.mockReset()
  })

  it('renders a live Anthropic model that is absent from the catalog', async () => {
    mocks.listModels.mockResolvedValue({
      providerKey: 'anthropic',
      models: ['claude-opus-4-8'],
      count: 1,
      fetchedAt: '2026-08-10T00:00:00.000Z',
    })

    renderPicker()

    expect(await screen.findByText('Claude Opus 4.8')).toBeTruthy()
    expect(screen.getAllByText('Claude Opus 4.7')).toHaveLength(2)
  })

  it('keeps a live model selected after the provider sync effect runs', async () => {
    mocks.listModels.mockResolvedValue({
      providerKey: 'anthropic',
      models: ['claude-opus-4-8'],
      count: 1,
      fetchedAt: '2026-08-10T00:00:00.000Z',
    })

    mocks.getDesktopApi.mockReturnValue({
      llm: { listModels: mocks.listModels },
    })
    render(<SelectionHarness />)
    fireEvent.click(screen.getByRole('button'))

    const liveModel = await screen.findByText('Claude Opus 4.8')
    fireEvent.click(liveModel.closest('button') ?? liveModel)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Claude Opus 4.8' })).toBeTruthy()
    })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(screen.getByRole('button', { name: 'Claude Opus 4.8' })).toBeTruthy()
  })

  it('silently falls back to the catalog when the API key is missing', async () => {
    mocks.listModels.mockRejectedValue(new Error('Anthropic API key is required'))

    renderPicker(createProviderConfig({ hasApiKey: false, apiKey: undefined }))

    expect((await screen.findAllByText('Claude Opus 4.7')).length).toBeGreaterThan(1)
    expect(screen.queryByText('Unable to load models')).toBeNull()
  })

  it('renders the unavailable state when live model loading fails', async () => {
    mocks.listModels.mockRejectedValue(new Error('Anthropic request failed'))

    renderPicker()

    expect(await screen.findByText('Unable to load models')).toBeTruthy()
  })
})
