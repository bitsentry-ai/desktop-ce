import { captureIncidentException, loadDesktopIncidents, saveDesktopIncidentThread } from "./incidentDesktopApi";
import { stopTrackingAddedIncidents, trackAddedIncidents, useIncidentListStore } from "./incidentListStore";
import type { IncidentThread } from "./types";

/** Main keeps the first archive time, so re-archiving does not move it. */
function threadArchivedAt(incident: IncidentThread): string | null {
  if (incident.archived !== true) return null;
  return incident.archivedAt ?? new Date().toISOString();
}

/**
 * The metadata fields that changed since `saved`, or every field for a new
 * thread; null when nothing changed. The preview follows messages, which main
 * persists.
 */
function threadMetadataPatch(saved: IncidentThread | undefined, incident: IncidentThread): ({ id: string } & Record<string, unknown>) | null {
  const patch: { id: string } & Record<string, unknown> = { id: incident.id };
  if (saved === undefined || saved.title !== incident.title) patch.title = incident.title;
  if (saved === undefined || saved.prompt !== incident.prompt) patch.prompt = incident.prompt;
  if (saved === undefined || saved.state !== incident.state) patch.state = incident.state;
  if (saved === undefined || saved.sessionId !== incident.sessionId) patch.sessionId = incident.sessionId ?? null;
  if (saved === undefined || saved.createdAt !== incident.createdAt) patch.createdAt = incident.createdAt;
  if (saved === undefined || (saved.archived === true) !== (incident.archived === true)) patch.archivedAt = threadArchivedAt(incident);
  return Object.keys(patch).length > 1 ? patch : null;
}

// Thread rows as main last acknowledged them. Seeded by a desktop load, updated only after a save resolves.
let persisted = new Map<string, IncidentThread>();
// Threads with a save in flight; each is re-diffed once its save settles.
const saving = new Set<string>();
let unsubscribe: (() => void) | null = null;

function persistThread(incident: IncidentThread): void {
  if (saving.has(incident.id)) return;
  const saved = persisted.get(incident.id);
  if (saved === incident) return;
  const patch = threadMetadataPatch(saved, incident);
  if (patch === null) {
    persisted.set(incident.id, incident);
    return;
  }
  saving.add(incident.id);
  saveDesktopIncidentThread(patch)
    .then(() => { persisted.set(incident.id, incident); })
    .catch((error: unknown) => {
      // The old baseline stays, so the failed fields are re-sent with the next change.
      console.error("Failed to save incident to desktop store:", error);
      captureIncidentException(error, { operation: "saveDesktopIncidentThread", incidentId: incident.id });
    })
    .finally(() => {
      saving.delete(incident.id);
      const current = useIncidentListStore.getState().incidents.find((row) => row.id === incident.id);
      if (current !== undefined && current !== incident) persistThread(current);
    });
}

function persistAll(incidents: IncidentThread[]): void {
  for (const incident of incidents) persistThread(incident);
}

/**
 * Saves desktop metadata changes from the store, whichever view made them and whether or not the incidents page is
 * mounted. Idempotent; started by the first successful desktop load.
 */
function startDesktopIncidentPersistence(): void {
  if (unsubscribe !== null) return;
  unsubscribe = useIncidentListStore.subscribe((state, previous) => {
    if (state.incidents !== previous.incidents) persistAll(state.incidents);
  });
  persistAll(useIncidentListStore.getState().incidents);
}

let desktopLoad: Promise<IncidentThread[]> | null = null;

/**
 * Loads the desktop list from main into the store until one load succeeds; concurrent callers share the request.
 * Rows added while the request is in flight are kept, and saved as new threads.
 */
export function loadDesktopIncidentList(): Promise<IncidentThread[]> {
  const store = useIncidentListStore.getState();
  if (store.loadedFrom === "desktop") return Promise.resolve(store.incidents);
  if (desktopLoad !== null) return desktopLoad;
  const added = trackAddedIncidents();
  desktopLoad = loadDesktopIncidents()
    .then((list) => {
      const fromMain = new Set(list.map((row) => row.id));
      const kept = useIncidentListStore.getState().incidents.filter((row) => added.has(row.id) && !fromMain.has(row.id));
      persisted = new Map(list.map((row) => [row.id, row]));
      useIncidentListStore.getState().setAll([...kept, ...list], "desktop");
      startDesktopIncidentPersistence();
      return useIncidentListStore.getState().incidents;
    })
    .finally(() => {
      stopTrackingAddedIncidents();
      desktopLoad = null;
    });
  return desktopLoad;
}

/**
 * Refreshes each row's preview from main, which keeps it current when a turn settles while the incidents page is
 * not mounted. Other fields stay as the renderer has them.
 */
export async function refreshDesktopIncidentPreviews(): Promise<void> {
  if (useIncidentListStore.getState().loadedFrom !== "desktop") return;
  const list = await loadDesktopIncidents();
  const { incidents, patch } = useIncidentListStore.getState();
  const current = new Map(incidents.map((row) => [row.id, row]));
  for (const row of list) {
    const preview = row.lastMessagePreview ?? null;
    const existing = current.get(row.id);
    if (existing !== undefined && (existing.lastMessagePreview ?? null) !== preview) patch(row.id, { lastMessagePreview: preview });
  }
}
