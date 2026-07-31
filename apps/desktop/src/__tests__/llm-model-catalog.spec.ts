import { describe, expect, it } from 'vitest'
import type { SavedProviderConfig } from '@bitsentry-ce/components/chat/types'
import {
  getCatalogModelIds,
  getModelDisplayName,
} from '@bitsentry-ce/components/llm/modelCatalog'
import { getProviderModelOptions } from '@bitsentry-ce/components/chat/utils'
import { resolveIncidentModelSelection } from '@bitsentry-ce/components/investigation/provider-selection'
import { buildDesktopLocalProviderRecords } from '@bitsentry-ce/core/features/desktop/desktop-llm-provider-settings'

function providerConfig(
  model: string,
  availableModels: string[],
): SavedProviderConfig {
  return {
    hasApiKey: false,
    baseUrl: '',
    model,
    availableModels,
    isSelectable: true,
    isPrimary: false,
  }
}

describe('local model catalog selection', () => {
  it('does not expose Codex models rejected for ChatGPT accounts', () => {
    const models = getCatalogModelIds('codex')

    expect(models).toContain('gpt-5.4')
    expect(models).toContain('gpt-5.3-codex')
    expect(models).not.toContain('gpt-5.2-codex')
    expect(models).not.toContain('gpt-5.1-codex-mini')

    expect(getProviderModelOptions('codex', {
      codex: providerConfig('gpt-5.2-codex', []),
    })).not.toContain('gpt-5.2-codex')
  })

  it('treats a non-empty Codex capability snapshot as authoritative', () => {
    const models = getProviderModelOptions('codex', {
      codex: providerConfig('gpt-5.2-codex', [
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.2-codex',
      ]),
    })

    expect(models).toEqual(['gpt-5.4', 'gpt-5.3-codex'])
  })

  it('falls back from an invalid incident lock to the synced default model', () => {
    const availableModels = [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]

    expect(resolveIncidentModelSelection(
      'codex',
      {
        codex: providerConfig('gpt-5.6-terra', availableModels),
      },
      'gpt-5.2-codex',
    )).toEqual({
      modelId: 'gpt-5.6-terra',
      droppedModelId: 'gpt-5.2-codex',
    })
  })

  it('uses catalog display labels for discovered Codex models', () => {
    expect(getModelDisplayName('codex', 'gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(getModelDisplayName('codex', 'gpt-5.6-terra')).toBe('GPT-5.6 Terra')
  })

  it('reads the persisted availability snapshot when discovery is empty', async () => {
    const availableModels = ['gpt-5.6-sol', 'gpt-5.6-terra']
    const provider = {
      getSettings: () => ({
        claudeCode: { enabled: false },
        codex: { enabled: true },
        opencode: { enabled: false },
        cursor: { enabled: false },
      }),
      isReady: () => true,
      listModels: async () => [],
    }

    const records = await buildDesktopLocalProviderRecords({
      localAiProvider: provider,
      primaryProviderKey: 'codex',
      readModelSetting: async () => 'gpt-5.6-terra',
      readAvailableModels: async () => availableModels,
      resolveAvailableModels: async () => [],
    })

    expect(records.codex?.availableModels).toEqual(availableModels)
  })

  it('keeps Claude and Cursor catalog options independent of Codex filtering', () => {
    expect(getProviderModelOptions('claude_code', {
      claude_code: providerConfig('', []),
    })).toContain('claude-sonnet-5')
    expect(getProviderModelOptions('cursor', {
      cursor: providerConfig('', []),
    })).toContain('composer-2.5')
  })
})
