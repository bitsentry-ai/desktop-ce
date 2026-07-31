export function resolveSyncedDefaultModel(
  currentModel: string,
  availableModels: string[],
): string {
  if (currentModel.length === 0 || availableModels.includes(currentModel)) {
    return currentModel
  }

  return availableModels[0] ?? ''
}
