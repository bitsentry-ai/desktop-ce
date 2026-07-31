import type { SavedProviderConfig } from "../chat/types";
import { getProviderModelOptions } from "../chat/utils";
import type { ModelCatalogProviderKey } from "../llm/modelCatalog";

export interface IncidentModelSelection {
  modelId: string;
  droppedModelId?: string;
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
