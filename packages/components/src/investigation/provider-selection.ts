import type { SavedProviderConfig } from "../chat/types";
import { getProviderModelOptions } from "../chat/utils";
import type { ModelCatalogProviderKey } from "../llm/modelCatalog";

export interface IncidentModelSelection {
  modelId: string;
  droppedModelId?: string;
}

export function resolveSyncedModelId(
  selectedProviderKey: ModelCatalogProviderKey | null,
  nextProviderKey: ModelCatalogProviderKey,
  selectedModelId: string,
  preferredModel: string | undefined,
  modelOptions: readonly string[],
): string {
  if (selectedProviderKey === nextProviderKey && selectedModelId.length > 0) {
    return selectedModelId;
  }

  if (
    preferredModel !== undefined &&
    preferredModel.length > 0 &&
    modelOptions.includes(preferredModel)
  ) {
    return preferredModel;
  }

  return modelOptions[0] ?? "";
}

/**
 * Resolve an incident's saved model against the current provider options.
 * A stale per-incident lock must never outrank the synced provider default.
 */
export function resolveIncidentModelSelection(
  providerKey: ModelCatalogProviderKey,
  providerConfigs: Record<string, SavedProviderConfig>,
  lockedModelId: string,
): IncidentModelSelection {
  const options = getProviderModelOptions(providerKey, providerConfigs);
  if (options.includes(lockedModelId)) {
    return { modelId: lockedModelId };
  }

  const preferredModel = providerConfigs[providerKey]?.model?.trim();
  const modelId =
    preferredModel !== undefined && options.includes(preferredModel)
      ? preferredModel
      : options[0] ?? "";

  return {
    modelId,
    ...(lockedModelId.length > 0 ? { droppedModelId: lockedModelId } : {}),
  };
}
