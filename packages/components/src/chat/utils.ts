import {
  type ModelCatalogProviderKey,
  filterSelectableModelIds,
  getCatalogModelIds,
} from "../llm/modelCatalog";
import type { SavedProviderConfig } from "./types";

/**
 * Format duration in milliseconds to human-readable string.
 * Examples: 500 -> "0.5s", 1500 -> "1.5s", 3500 -> "3.5s", 60000 -> "60s"
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms / 100) / 10)}s`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${String(Math.round(ms / 1000))}s`;
}

export function getProviderModelOptions(
  providerKey: ModelCatalogProviderKey,
  savedProviders: Record<string, SavedProviderConfig>,
): string[] {
  const saved = savedProviders[providerKey];
  let discoveredModels: string[] = [];
  if (Array.isArray(saved?.availableModels)) {
    discoveredModels = saved.availableModels;
  }

  // A non-empty Codex discovery result is an account capability snapshot. Do
  // not merge stale static/saved selections back into that authoritative list.
  const hasCodexCapabilitySnapshot = providerKey === "codex" && discoveredModels.length > 0;
  const merged = hasCodexCapabilitySnapshot
    ? discoveredModels
    : [
      ...discoveredModels,
      ...getCatalogModelIds(providerKey),
      ...(saved?.model === undefined ? [] : [saved.model]),
    ];

  return filterSelectableModelIds(providerKey, merged);
}
