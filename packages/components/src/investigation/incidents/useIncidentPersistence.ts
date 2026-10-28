import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../chat/types";
import { settleInterruptedAgentTurn } from "../../chat/runtimeProjection";
import {
  captureIncidentException,
  hasDesktopIncidentsApi,
  isMissingIncidentsHandlerError,
  appendDesktopIncidentMessages,
  loadDesktopIncidentMessages,
  loadDesktopIncidents,
  saveDesktopIncidentThread,
} from "./incidentDesktopApi";
import {
  LOCAL_SAVE_DEBOUNCE_MS,
  LOCAL_SAVE_MAX_WAIT_MS,
  loadIncidentMessages,
  loadIncidents,
  saveIncidentMessages,
  saveIncidents,
} from "./incidentStorage";
import type { IncidentThread } from "./types";

function announceIncidentsUpdated() {
  window.dispatchEvent(new CustomEvent("bitsentry:incidents-updated"));
}

/** Main keeps the first archive time, so re-archiving does not move it. */
function threadArchivedAt(incident: IncidentThread): string | null {
  return incident.archived === true ? new Date().toISOString() : null;
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

/** Web mode keeps the whole state in local storage, saved on a debounce while streaming. */
function useLocalIncidentStorage(
  enabled: boolean,
  incidents: IncidentThread[],
  messagesMap: Record<string, ChatMessage[]>,
) {
  const pendingRef = useRef<{ incidents: IncidentThread[]; messagesMap: Record<string, ChatMessage[]> } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSinceRef = useRef<number | null>(null);
  const announcedRef = useRef<IncidentThread[] | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingSinceRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    saveIncidents(pending.incidents);
    saveIncidentMessages(pending.messagesMap);
    if (announcedRef.current === pending.incidents) return;
    announcedRef.current = pending.incidents;
    announceIncidentsUpdated();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    pendingRef.current = { incidents, messagesMap };
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    const now = Date.now();
    pendingSinceRef.current ??= now;
    const delay = Math.min(LOCAL_SAVE_DEBOUNCE_MS, Math.max(0, pendingSinceRef.current + LOCAL_SAVE_MAX_WAIT_MS - now));
    timerRef.current = setTimeout(flush, delay);
  }, [enabled, flush, incidents, messagesMap]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);
}

/**
 * Loads the incident list, and each thread's messages when it is opened. Main
 * persists agent output; this saves metadata changes one thread at a time and
 * the few message changes the renderer makes itself.
 */
export function useIncidentPersistence(activeId: string | null) {
  const [desktopStoreMode, setDesktopStoreMode] = useState<"desktop" | "local">(
    () => (hasDesktopIncidentsApi() ? "desktop" : "local"),
  );
  const isDesktopIncidents = desktopStoreMode === "desktop";

  const [incidents, setIncidents] = useState<IncidentThread[]>(() => {
    if (isDesktopIncidents) return [];
    return loadIncidents();
  });
  const [messagesMap, setMessagesMap] = useState<Record<string, ChatMessage[]>>(
    () => {
      if (isDesktopIncidents) return {};
      return loadIncidentMessages();
    },
  );
  const [desktopHydrated, setDesktopHydrated] = useState(!isDesktopIncidents);
  const desktopStoreFallbackLoggedRef = useRef(false);
  // Thread rows as last loaded or saved, to save only the ones that changed.
  const savedThreadsRef = useRef(new Map<string, IncidentThread>());
  const incidentsRef = useRef(incidents);
  const messagesMapRef = useRef(messagesMap);
  const isDesktopIncidentsRef = useRef(isDesktopIncidents);
  incidentsRef.current = incidents;
  messagesMapRef.current = messagesMap;
  isDesktopIncidentsRef.current = isDesktopIncidents;

  useLocalIncidentStorage(!isDesktopIncidents, incidents, messagesMap);

  useEffect(() => {
    if (!isDesktopIncidents) return;

    let cancelled = false;
    void loadDesktopIncidents()
      .then((loaded) => {
        if (cancelled) return;
        for (const incident of loaded) savedThreadsRef.current.set(incident.id, incident);
        setIncidents(loaded);
        setDesktopHydrated(true);
      })
      .catch((error: unknown) => {
        if (isMissingIncidentsHandlerError(error)) {
          if (!desktopStoreFallbackLoggedRef.current) {
            desktopStoreFallbackLoggedRef.current = true;
            console.warn(
              "Incidents desktop IPC unavailable, falling back to local storage.",
            );
          }
        } else {
          console.error("Failed to load incidents from desktop store:", error);
          captureIncidentException(error, {
            operation: "loadDesktopIncidents",
            hasDesktopIncidentsApi: true,
          });
        }
        if (!cancelled) {
          setIncidents(loadIncidents());
          setMessagesMap(loadIncidentMessages());
          setDesktopStoreMode("local");
          setDesktopHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isDesktopIncidents]);

  useEffect(() => {
    if (!isDesktopIncidents || !desktopHydrated || activeId === null) return;
    if (messagesMapRef.current[activeId] !== undefined) return;

    let cancelled = false;
    void loadDesktopIncidentMessages(activeId)
      .then((loaded) => {
        if (cancelled) return;
        // Without a session nothing can still be answering, so an unfinished turn was interrupted.
        const hasSession = incidentsRef.current.some((incident) => incident.id === activeId && incident.sessionId !== undefined);
        const messages = hasSession ? loaded : settleInterruptedAgentTurn(loaded, new Date().toISOString());
        setMessagesMap((prev) => (prev[activeId] === undefined ? { ...prev, [activeId]: messages } : prev));
      })
      .catch((error: unknown) => {
        console.error("Failed to load incident messages from desktop store:", error);
        captureIncidentException(error, { operation: "loadDesktopIncidentMessages", incidentId: activeId });
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, desktopHydrated, isDesktopIncidents]);

  useEffect(() => {
    if (!isDesktopIncidents || !desktopHydrated) return;

    for (const incident of incidents) {
      const saved = savedThreadsRef.current.get(incident.id);
      savedThreadsRef.current.set(incident.id, incident);
      if (saved === incident) continue;
      const patch = threadMetadataPatch(saved, incident);
      if (patch === null) continue;
      void saveDesktopIncidentThread(patch)
        .then(announceIncidentsUpdated)
        .catch((error: unknown) => {
          // Restore the old baseline so the failed fields are re-sent with the next change.
          if (savedThreadsRef.current.get(incident.id) === incident) {
            if (saved === undefined) savedThreadsRef.current.delete(incident.id);
            else savedThreadsRef.current.set(incident.id, saved);
          }
          console.error("Failed to save incident to desktop store:", error);
          captureIncidentException(error, { operation: "saveDesktopIncidentThread", incidentId: incident.id });
        });
    }
  }, [desktopHydrated, incidents, isDesktopIncidents]);

  /**
   * Appends messages to a thread no live agent session owns, and saves just
   * those. Main appends after its stored rows, so history the renderer has not
   * loaded is never dropped.
   */
  const appendThreadMessages = useCallback((incidentId: string, added: ChatMessage[]) => {
    const next = [...(messagesMapRef.current[incidentId] ?? []), ...added];
    messagesMapRef.current = { ...messagesMapRef.current, [incidentId]: next };
    setMessagesMap((prev) => ({ ...prev, [incidentId]: [...(prev[incidentId] ?? []), ...added] }));
    if (!isDesktopIncidentsRef.current) return;
    void appendDesktopIncidentMessages(incidentId, added).catch((error: unknown) => {
      console.error("Failed to save incident messages to desktop store:", error);
      captureIncidentException(error, { operation: "appendDesktopIncidentMessages", incidentId });
    });
  }, []);

  return {
    incidents,
    setIncidents,
    messagesMap,
    setMessagesMap,
    appendThreadMessages,
    desktopHydrated,
    isDesktopIncidents,
  };
}
