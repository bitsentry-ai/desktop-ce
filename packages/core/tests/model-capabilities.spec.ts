import { describe, expect, it } from 'vitest'
import { filterChatCompletionModelIds } from '../src/shared/model-capabilities'

describe('chat model capability classification', () => {
  it('keeps chat-capable IDs and removes non-chat /v1/models entries', () => {
    const modelIds = [
      'gpt-5.6-luna',
      'gpt-4o',
      'qwen/qwen3.5-plus',
      'moonshotai/kimi-k2.5',
      'z-ai/glm-5',
      'gpt-4o-realtime-preview',
      'text-embedding-ada-002',
      'tts-1',
      'whisper-1',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-image-1',
      'gpt-4o-audio-preview',
      'gpt-4o-realtime-transcribe',
    ]

    expect(filterChatCompletionModelIds(modelIds)).toEqual([
      'gpt-5.6-luna',
      'gpt-4o',
      'qwen/qwen3.5-plus',
      'moonshotai/kimi-k2.5',
      'z-ai/glm-5',
      'gpt-4o-realtime-preview',
    ])
  })
})
