import type { RunbooksServicePort } from "../services";

export const RUNBOOKS_NAV_CACHE_KEY = "bitsentry_runbooks";

export type RunbookNavItem = {
  id: string;
  title: string;
  actions: unknown[];
};

type RunbookNavStorage = Pick<Storage, "getItem" | "setItem">;

function getDefaultStorage(): RunbookNavStorage | null {
  if (typeof localStorage === "undefined") {
    return null;
  }

  return localStorage;
}

export function normalizeRunbookNavItems(items: unknown[]): RunbookNavItem[] {
  return items
    .map((item): RunbookNavItem | null => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const record = item as {
        id?: unknown;
        title?: unknown;
        actions?: unknown;
      };

      if (typeof record.id !== "string" || record.id.length === 0) {
        return null;
      }

      const title =
        typeof record.title === "string" && record.title.trim().length > 0
          ? record.title.trim()
          : "Untitled Runbook";
      const actions = Array.isArray(record.actions) ? record.actions : [];

      return { id: record.id, title, actions };
    })
    .filter((item): item is RunbookNavItem => item !== null);
}

export function readLocalRunbookNavItems(
  storage: RunbookNavStorage | null = getDefaultStorage(),
): RunbookNavItem[] {
  if (storage === null) {
    return [];
  }

  try {
    const raw = storage.getItem(RUNBOOKS_NAV_CACHE_KEY);
    if (raw === null) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeRunbookNavItems(parsed) : [];
  } catch {
    return [];
  }
}

export function writeLocalRunbookNavItems(
  items: unknown[],
  storage: RunbookNavStorage | null = getDefaultStorage(),
): void {
  if (storage === null) {
    return;
  }

  try {
    storage.setItem(RUNBOOKS_NAV_CACHE_KEY, JSON.stringify(items));
  } catch {
    // A cache failure must not hide a successful runbook list response.
  }
}

export async function loadRunbookNavItems(
  runbooks: Pick<RunbooksServicePort, "list">,
  storage: RunbookNavStorage | null = getDefaultStorage(),
): Promise<RunbookNavItem[]> {
  try {
    const latestRunbooks = await runbooks.list();
    writeLocalRunbookNavItems(latestRunbooks, storage);
    return normalizeRunbookNavItems(latestRunbooks);
  } catch {
    return readLocalRunbookNavItems(storage);
  }
}
