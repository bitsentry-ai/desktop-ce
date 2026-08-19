import { describe, expect, it } from 'vitest'

import { resolveCatalogModel } from '../src/features/llm/modelCatalog'

describe('model catalog resolution', () => {
  it.each(['gpt-5.6-terra', 'GPT 5.6 Terra', 'GPT-5.6 Terra'])(
    'resolves %s to the canonical OpenAI selection',
    (value) => {
      expect(resolveCatalogModel(value)).toEqual({
        providerKey: 'openai',
        modelId: 'gpt-5.6-terra',
      })
    },
  )

  it('preserves provider-prefixed OpenRouter IDs', () => {
    expect(resolveCatalogModel('openrouter/openai/gpt-5.6-terra')).toEqual({
      providerKey: 'opencode',
      modelId: 'openrouter/openai/gpt-5.6-terra',
    })
  })

  it('returns undefined for an unknown model', () => {
    expect(resolveCatalogModel('GPT 5.6 Terra (invalid)')).toBeUndefined()
  })
})
