import { create } from "zustand";
import type { IncidentThread } from "./types";

interface IncidentListStore {
  /** Threads in sidebar order, newest first. */
  incidents: IncidentThread[];
  loaded: boolean;
  /** Where the list came from; a local fallback does not count as desktop hydration. */
  loadedFrom: "desktop" | "local" | null;
  setAll: (list: IncidentThread[], source?: "desktop" | "local") => void;
  /** Replaces the row with the same id, or adds the thread at the top. */
  upsert: (thread: IncidentThread) => void;
  patch: (id: string, partial: Partial<Omit<IncidentThread, "id">>) => void;
  archive: (id: string, archivedAt: string) => void;
  unarchive: (id: string) => void;
}

function sameRow(a: IncidentThread, b: IncidentThread): boolean {
  const keys = Object.keys(a) as Array<keyof IncidentThread>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Replaces one row, keeping the array and the row when nothing changes. */
function patchRow(list: IncidentThread[], id: string, partial: Partial<IncidentThread>): IncidentThread[] {
  const index = list.findIndex((row) => row.id === id);
  if (index === -1) return list;
  const row = list[index];
  const changed = (Object.keys(partial) as Array<keyof IncidentThread>).some((key) => row[key] !== partial[key]);
  if (!changed) return list;
  const next = [...list];
  next[index] = { ...row, ...partial };
  return next;
}

// Ids of rows added while a desktop load is in flight, so the load result keeps them.
let addedWhileLoading: Set<string> | null = null;

/** Starts recording the ids of rows added from now on; returns them. Stops with `stopTrackingAddedIncidents`. */
export function trackAddedIncidents(): Set<string> {
  addedWhileLoading = new Set();
  return addedWhileLoading;
}

export function stopTrackingAddedIncidents(): void {
  addedWhileLoading = null;
}

/**
 * The incident list shared by the incidents page and the navbar. Desktop metadata is persisted by a store
 * subscription in `incidentListPersistence`.
 * Every action keeps the array, and each unchanged row, when nothing changed, so selectors stay quiet.
 */
export const useIncidentListStore = create<IncidentListStore>()((set) => {
  const update = (next: (list: IncidentThread[]) => IncidentThread[]) => {
    set((state) => {
      const incidents = next(state.incidents);
      return incidents === state.incidents ? state : { incidents };
    });
  };
  return {
    incidents: [],
    loaded: false,
    loadedFrom: null,
    setAll: (list, source = "local") => {
      set((state) => {
        const previous = new Map(state.incidents.map((row) => [row.id, row]));
        const incidents = list.map((row) => {
          const kept = previous.get(row.id);
          return kept !== undefined && sameRow(kept, row) ? kept : row;
        });
        const same = incidents.length === state.incidents.length && incidents.every((row, index) => row === state.incidents[index]);
        if (same && state.loaded && state.loadedFrom === source) return state;
        return { incidents: same ? state.incidents : incidents, loaded: true, loadedFrom: source };
      });
    },
    upsert: (thread) => {
      update((list) => {
        const index = list.findIndex((row) => row.id === thread.id);
        if (index === -1) {
          addedWhileLoading?.add(thread.id);
          return [thread, ...list];
        }
        if (sameRow(list[index], thread)) return list;
        const next = [...list];
        next[index] = thread;
        return next;
      });
    },
    patch: (id, partial) => { update((list) => patchRow(list, id, partial)); },
    archive: (id, archivedAt) => {
      update((list) => {
        const row = list.find((item) => item.id === id);
        // An archived thread keeps its first archive time.
        if (row === undefined || row.archived === true) return list;
        return patchRow(list, id, { archived: true, archivedAt });
      });
    },
    unarchive: (id) => { update((list) => patchRow(list, id, { archived: false, archivedAt: undefined })); },
  };
});
