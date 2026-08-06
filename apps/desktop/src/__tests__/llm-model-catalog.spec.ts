import { describe, expect, it } from 'vitest'
import type { SavedProviderConfig } from '@bitsentry-ce/components/chat/types'
import enAUCommon from '../../../../packages/i18n/src/locales/en-AU/common.json'
import enGBCommon from '../../../../packages/i18n/src/locales/en-GB/common.json'
import enUSCommon from '../../../../packages/i18n/src/locales/en-US/common.json'
import frFRCommon from '../../../../packages/i18n/src/locales/fr-FR/common.json'
import idIDCommon from '../../../../packages/i18n/src/locales/id-ID/common.json'
import zhCNCommon from '../../../../packages/i18n/src/locales/zh-CN/common.json'
import {
  type ModelCatalogEntry,
  type ComposerSelectOption,
  getCatalogModel,
  getCatalogModelIds,
  getEffectiveComposerOptions,
  getModelCapability,
  getModelDisplayName,
  getProviderCatalogModels,
  resolveCatalogModelRuntimeSelection,
} from '@bitsentry-ce/components/llm/modelCatalog'
import { getProviderModelOptions } from '@bitsentry-ce/components/chat/utils'
import { resolveIncidentModelSelection } from '@bitsentry-ce/components/investigation/provider-selection'
import { buildDesktopLocalProviderRecords } from '@bitsentry-ce/core/features/desktop/desktop-llm-provider-settings'
import { resolveSyncedDefaultModel } from '@bitsentry-ce/components/settings/model-selection'

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

const commonTranslationsByLocale: Record<string, Record<string, string>> = {
  'en-US': enUSCommon,
  'en-GB': enGBCommon,
  'en-AU': enAUCommon,
  'fr-FR': frFRCommon,
  'zh-CN': zhCNCommon,
  'id-ID': idIDCommon,
}

const cliProviders = ['claude_code', 'codex', 'opencode', 'cursor'] as const

function getCliEffortLabelKeys(providerKey: (typeof cliProviders)[number]): string[] {
  const capabilities = [
    ...getProviderCatalogModels(providerKey),
    getModelCapability(providerKey, `future-${providerKey}-model`),
  ]

  return capabilities.flatMap((capability) => {
    const effort = capability?.composerOptions?.find((option) => option.id === 'effort')
    if (effort?.type !== 'select') return []

    return [
      effort.label,
      ...effort.options.flatMap((choice) =>
        [choice.label, choice.shortLabel].filter((label): label is string => Boolean(label)),
      ),
    ]
  })
}

describe('local model catalog selection', () => {
  it('localizes every CLI effort label in the catalog and fallback descriptors', async () => {
    const labelKeys = new Set(cliProviders.flatMap(getCliEffortLabelKeys))

    expect(labelKeys.size).toBeGreaterThan(0)
    for (const key of labelKeys) {
      expect(key).toMatch(/^common\.traitsDropdown\./)
    }

    for (const translations of Object.values(commonTranslationsByLocale)) {
      for (const key of labelKeys) {
        expect(translations[key]).toEqual(expect.any(String))
        expect(translations[key]).not.toBe(key)
      }
    }
  })
})

function derivedEffortModel(
  defaultReasoningOption: 'low' | 'high',
): ModelCatalogEntry {
  return {
    id: `derived-${defaultReasoningOption}`,
    displayName: `Derived ${defaultReasoningOption}`,
    supportsImageInput: false,
    supportsAudioInput: false,
    supportsVideoInput: false,
    supportsPdfInput: false,
    supportsThinking: false,
    thinkingMode: 'unsupported',
    reasoningOptions: ['low', 'medium', 'high'],
    defaultReasoningOption,
  }
}

describe('local model catalog selection', () => {
  it('uses the catalog default for derived effort options', () => {
    const model = derivedEffortModel('high')
    const effort = getEffectiveComposerOptions(model).find((option) => option.id === 'effort')

    expect(effort).toMatchObject({ type: 'select' })
    if (effort?.type !== 'select') throw new Error('Derived model must expose effort')
    expect(effort.options.filter((option) => option.isDefault)).toEqual([
      expect.objectContaining({ value: 'high' }),
    ])
    const reorderedModel: ModelCatalogEntry = {
      ...model,
      reasoningOptions: ['high', 'low', 'medium'],
    }
    const reorderedEffort = getEffectiveComposerOptions(reorderedModel)
      .find((option) => option.id === 'effort')
    expect(reorderedEffort).toMatchObject({ type: 'select' })
    if (reorderedEffort?.type !== 'select') throw new Error('Derived model must expose effort')
    expect(reorderedEffort.options.filter((option) => option.isDefault)).toEqual([
      expect.objectContaining({ value: 'high' }),
    ])
  })

  it('gives every catalog effort selector exactly one default', () => {
    const providerKeys = [
      'groq',
      'kilocode',
      'openai',
      'anthropic',
      'gemini',
      'openrouter',
      'claude_code',
      'codex',
      'opencode',
      'cursor',
    ] as const
    const effortSelectors = providerKeys.flatMap((providerKey) =>
      getProviderCatalogModels(providerKey)
        .map((model) => getEffectiveComposerOptions(model).find((option) => option.id === 'effort'))
        .filter((option): option is ComposerSelectOption => option?.type === 'select'),
    )

    expect(effortSelectors.length).toBeGreaterThan(0)
    for (const effort of effortSelectors) {
      expect(effort.options.filter((option) => option.isDefault)).toHaveLength(1)
    }
  })

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

  it('gives uncataloged CLI models provider-specific effort options', () => {
    const expectedDefaults = {
      claude_code: 'high',
      codex: 'high',
      opencode: 'medium',
      cursor: 'high',
    } as const

    for (const [providerKey, defaultValue] of Object.entries(expectedDefaults) as Array<[
      keyof typeof expectedDefaults,
      string,
    ]>) {
      const capability = getModelCapability(providerKey, `future-${providerKey}-model`)
      const effort = capability?.composerOptions?.find((option) => option.id === 'effort')

      expect(capability?.id).toBe(`future-${providerKey}-model`)
      expect(effort?.type).toBe('select')
      if (effort?.type !== 'select') throw new Error('CLI fallback must expose an effort selector')
      expect(effort.options.some((option) => option.isDefault && option.value === defaultValue)).toBe(true)
    }
  })

  it('keeps catalog capabilities exact and does not infer API capabilities', () => {
    const catalogCapability = getCatalogModel('codex', 'gpt-5.4')

    expect(getModelCapability('codex', 'gpt-5.4')).toBe(catalogCapability)
    expect(getModelCapability('openai', 'gpt-future-unknown')).toBeUndefined()
  })

  it('normalizes the legacy Cursor default ID to the Cursor ACP auto ID', () => {
    const cursorModels = getCatalogModelIds('cursor')

    expect(cursorModels).toContain('auto')
    expect(cursorModels).not.toContain('default')
    expect(getCatalogModel('cursor', 'default')?.id).toBe('auto')
    expect(getProviderModelOptions('cursor', {
      cursor: providerConfig('default', ['default']),
    })).toContain('auto')
    expect(resolveCatalogModelRuntimeSelection('cursor', 'default')).toEqual({
      modelId: 'auto',
      traitValues: {},
    })
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

  it('uses the persisted snapshot when live provider discovery fails', async () => {
    const records = await buildDesktopLocalProviderRecords({
      localAiProvider: {
        getSettings: () => ({
          claudeCode: { enabled: true },
          codex: { enabled: true },
          opencode: { enabled: false },
          cursor: { enabled: false },
        }),
        isReady: () => true,
        listModels: async () => [],
      },
      primaryProviderKey: 'codex',
      readModelSetting: async () => 'gpt-5.6-terra',
      readAvailableModels: async () => ['gpt-5.6-sol', 'gpt-5.6-terra'],
      resolveAvailableModels: async (providerKey) => {
        if (providerKey === 'codex') {
          throw new Error('Codex app-server unavailable')
        }

        return ['claude-sonnet']
      },
    })

    expect(records.codex?.availableModels).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])
    expect(records.claude_code?.availableModels).toEqual(['claude-sonnet'])
  })

  it('replaces a removed saved model during sync', () => {
    expect(resolveSyncedDefaultModel('gpt-5.2-codex', [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])).toBe('gpt-5.6-sol')
    expect(resolveSyncedDefaultModel('', ['gpt-5.6-sol'])).toBe('')
    expect(resolveSyncedDefaultModel('gpt-5.6-terra', [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ])).toBe('gpt-5.6-terra')
  })

  it('keeps Claude and Cursor catalog options independent of Codex filtering', () => {
    expect(getProviderModelOptions('claude_code', {
      claude_code: providerConfig('claude-sonnet-5', [
        'claude-sonnet-5',
        'claude-opus-5',
      ]),
    })).toEqual(['claude-sonnet-5', 'claude-opus-5'])
    expect(getProviderModelOptions('claude_code', {
      claude_code: providerConfig('claude-opus-4-8', ['claude-sonnet-5']),
    })).not.toContain('claude-opus-4-8')
    expect(getProviderModelOptions('cursor', {
      cursor: providerConfig('', []),
    })).toContain('composer-2.5')
  })
})
