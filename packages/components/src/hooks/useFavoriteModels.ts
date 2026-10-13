import { useCallback, useState } from "react";
import type { ModelCatalogProviderKey } from "../llm/modelCatalog";

const LS_KEY = "bitsentry_favorite_models";

type FavoriteEntry = { providerKey: ModelCatalogProviderKey; modelId: string };

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("providerKey" in value) || !("modelId" in value)) {
    return false;
  }

  return (
    typeof value.providerKey === "string" &&
    typeof value.modelId === "string"
  );
}

function loadFavorites(): FavoriteEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFavoriteEntry);
  } catch {
    return [];
  }
}

function saveFavorites(entries: FavoriteEntry[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // Storage can be unavailable (private mode or full quota); persistence is best effort.
  }
}

export function useFavoriteModels() {
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(loadFavorites);

  const isFavorite = useCallback(
    (providerKey: ModelCatalogProviderKey, modelId: string) =>
      favorites.some((f) => f.providerKey === providerKey && f.modelId === modelId),
    [favorites],
  );

  const toggleFavorite = useCallback(
    (providerKey: ModelCatalogProviderKey, modelId: string) => {
      setFavorites((prev) => {
        const exists = prev.some(
          (f) => f.providerKey === providerKey && f.modelId === modelId,
        );
        let next = [...prev, { providerKey, modelId }];
        if (exists) {
          next = prev.filter(
            (f) => !(f.providerKey === providerKey && f.modelId === modelId),
          );
        }
        saveFavorites(next);
        return next;
      });
    },
    [],
  );

  return { favorites, isFavorite, toggleFavorite };
}
