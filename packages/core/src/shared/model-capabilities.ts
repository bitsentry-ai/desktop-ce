const NON_CHAT_MODEL_ID_PATTERNS = [
  /(?:^|[-_\/.])embeddings?(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])tts(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])whisper(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])dall[-_]?e(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])moderation(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])image(?:$|[-_\/.])/i,
  /(?:^|[-_\/.])(?:realtime[-_]?transcrib|transcrib)(?:e|er|ing)?(?:$|[-_\/.])/i,
] as const

/**
 * OpenAI-compatible /models endpoints also return models for non-chat APIs.
 * Keep this classifier capability-based so new chat model IDs remain visible.
 */
export function isChatCompletionModelId(modelId: string): boolean {
  const normalizedModelId = modelId.trim()
  if (normalizedModelId.length === 0) return false

  return !NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(normalizedModelId))
}

export function filterChatCompletionModelIds(modelIds: string[]): string[] {
  return modelIds
    .map((modelId) => modelId.trim())
    .filter(isChatCompletionModelId)
}
