// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraitsDropdown } from '@bitsentry-ce/components/chat/TraitsDropdown'
import {
  getEffectiveComposerOptions,
  getModelCapability,
  type ModelCatalogProviderKey,
} from '@bitsentry-ce/components/llm/modelCatalog'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'common.traitsDropdown.traits': 'Traits',
      'common.traitsDropdown.reasoning': 'Effort',
      'common.traitsDropdown.reasoningLow': 'Low',
      'common.traitsDropdown.reasoningMedium': 'Medium',
      'common.traitsDropdown.reasoningHigh': 'High',
      'common.traitsDropdown.reasoningMax': 'Max',
      'common.traitsDropdown.reasoningExtraHigh': 'Extra high',
      'common.traitsDropdown.reasoningExtraHighShort': 'XHigh',
      'common.traitsDropdown.reasoningUltrathink': 'Ultrathink',
      'common.traitsDropdown.reasoningUltrathinkShort': 'Ultra',
    }[key] ?? key),
  }),
}))

afterEach(cleanup)

function renderEffortOptions(providerKey: ModelCatalogProviderKey, modelId: string): string[] {
  const capability = getModelCapability(providerKey, modelId)
  const options = capability === undefined ? [] : getEffectiveComposerOptions(capability)
  render(<TraitsDropdown options={options} values={{ effort: 'high' }} onChange={vi.fn()} />)

  const trigger = screen.queryByRole('button')
  if (trigger !== null) fireEvent.click(trigger)

  return ['Low', 'Medium', 'High', 'Max', 'Extra high', 'XHigh', 'Ultrathink', 'Ultra']
    .filter((label) => screen.queryAllByText(label).length > 0)
}

describe('model capability controls', () => {
  it('derives effort controls for an uncataloged Anthropic model from cataloged Claude entries', () => {
    const catalogedOptions = renderEffortOptions('anthropic', 'claude-opus-4-7')
    cleanup()

    const liveOptions = renderEffortOptions('anthropic', 'claude-opus-4-8')

    expect(liveOptions).toEqual(catalogedOptions)
    expect(liveOptions).toEqual(['Low', 'Medium', 'High', 'Max'])
  })

  it('keeps cataloged Claude Haiku without effort controls', () => {
    const capability = getModelCapability('anthropic', 'claude-haiku-4-5')
    expect(capability).toBeDefined()

    const options = getEffectiveComposerOptions(capability!)
    render(<TraitsDropdown options={options} values={{}} onChange={vi.fn()} />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps CLI fallback effort controls unchanged', () => {
    expect(renderEffortOptions('opencode', 'future-opencode-model')).toEqual([
      'Low',
      'Medium',
      'High',
    ])
  })
})
