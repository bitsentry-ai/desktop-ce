import {
  type ModelCatalogProviderKey,
  filterSelectableModelIds,
  getCatalogModelIds,
} from "../llm/modelCatalog";
import type { SavedProviderConfig } from "./types";

/** Compact elapsed time: "0.4s", "8.2s", "42s", "3m 05s", "2h 07m", "3d 4h". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms / 100) / 10)}s`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${String(totalSeconds)}s`;
  const pad = (value: number) => String(value).padStart(2, "0");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${String(totalMinutes)}m ${pad(totalSeconds % 60)}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${String(totalHours)}h ${pad(totalMinutes % 60)}m`;
  return `${String(Math.floor(totalHours / 24))}d ${String(totalHours % 24)}h`;
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

  // A non-empty CLI discovery result is an account capability snapshot. Do
  // not merge stale static/saved selections back into that authoritative list.
  const hasCapabilitySnapshot =
    (providerKey === "codex" || providerKey === "claude_code") &&
    discoveredModels.length > 0;
  const merged = hasCapabilitySnapshot
    ? discoveredModels
    : [
      ...discoveredModels,
      ...getCatalogModelIds(providerKey),
      ...(saved?.model === undefined ? [] : [saved.model]),
    ];

  return filterSelectableModelIds(providerKey, merged);
}
