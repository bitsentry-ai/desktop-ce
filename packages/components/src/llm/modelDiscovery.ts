import { useSyncExternalStore } from "react";
import type { SavedProviderConfig } from "../chat/types";
import { getProviderModelOptions } from "../chat/utils";
import {
  filterSelectableModelIds,
  type ModelCatalogProviderKey,
} from "./modelCatalog";

export type DiscoveredModelCache = Readonly<Record<string, readonly string[]>>;

let snapshot: DiscoveredModelCache = {};
const listeners = new Set<() => void>();

function areModelIdsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((modelId, index) => modelId === right[index]);
}

export function subscribeToDiscoveredModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDiscoveredModelsSnapshot(): DiscoveredModelCache {
  return snapshot;
}

export function useDiscoveredModels(): DiscoveredModelCache {
  return useSyncExternalStore(
    subscribeToDiscoveredModels,
    getDiscoveredModelsSnapshot,
    getDiscoveredModelsSnapshot,
  );
}

export function publishDiscoveredModels(
  providerKey: ModelCatalogProviderKey,
  modelIds: readonly string[],
): void {
  const models = filterSelectableModelIds(providerKey, [...modelIds]);
  const previous = snapshot[providerKey] ?? [];
  if (areModelIdsEqual(previous, models)) return;

  snapshot = { ...snapshot, [providerKey]: models };
  listeners.forEach((listener) => { listener(); });
}

export function clearDiscoveredModels(providerKey: ModelCatalogProviderKey): void {
  if (!(providerKey in snapshot)) return;

  const next = { ...snapshot };
  delete next[providerKey];
  snapshot = next;
  listeners.forEach((listener) => { listener(); });
}

export function mergeDiscoveredModelIds(
  providerKey: ModelCatalogProviderKey,
  modelIds: readonly string[],
  discoveredModels: DiscoveredModelCache = snapshot,
): string[] {
  return filterSelectableModelIds(providerKey, [
    ...modelIds,
    ...(discoveredModels[providerKey] ?? []),
  ]);
}

export function getProviderModelOptionsWithDiscovery(
  providerKey: ModelCatalogProviderKey,
  savedProviders: Record<string, SavedProviderConfig>,
  discoveredModels: DiscoveredModelCache = snapshot,
): string[] {
  return mergeDiscoveredModelIds(
    providerKey,
    getProviderModelOptions(providerKey, savedProviders),
    discoveredModels,
  );
}
