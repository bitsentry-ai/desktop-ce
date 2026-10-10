import { describe, expect, it } from 'vitest'
import { getProviderModelOptions } from '@bitsentry-ce/components/chat/utils'
import { formatModelDisplayName, getModelDisplayName } from '@bitsentry-ce/components/llm/modelCatalog'

describe('model display names', () => {
  it('formats OpenCode provider-prefixed model slugs without leaking raw separators', () => {
    expect(formatModelDisplayName('openai/gpt-5.4')).toBe('OpenAI GPT-5.4')
    expect(formatModelDisplayName('anthropic/claude-3-5-haiku')).toBe(
      'Anthropic Claude 3.5 Haiku',
    )
    expect(formatModelDisplayName('opencode/big-pickle')).toBe('Big Pickle')
    expect(formatModelDisplayName('opencode/deepseek-v4-flash-free')).toBe(
      'Deepseek V4 Flash Free',
    )
  })

  it('uses catalog names before fallback formatting', () => {
    expect(getModelDisplayName('opencode', 'openai/gpt-5')).toBe('OpenAI GPT-5')
  })

  it('keeps catalog fallback models when saved CLI models are partial', () => {
    const options = getProviderModelOptions('opencode', {
        opencode: {
          hasApiKey: true,
          baseUrl: '',
          model: 'opencode/big-pickle',
          availableModels: ['opencode/big-pickle'],
          isSelectable: true,
          isPrimary: true,
        },
      })

    expect(options[0]).toBe('opencode/big-pickle')
    expect(options).toContain('openai/gpt-5.5')
    expect(options).toContain('anthropic/claude-sonnet-5')
    expect(options).toContain('openai/gpt-5')
  })
})
