import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../chat/types";
import { settleInterruptedAgentTurn } from "../../chat/runtimeProjection";
import {
  captureIncidentException,
  hasDesktopIncidentsApi,
  isMissingIncidentsHandlerError,
  appendDesktopIncidentMessages,
  loadDesktopIncidentMessages,
} from "./incidentDesktopApi";
import { useIncidentListStore } from "./incidentListStore";
import { loadDesktopIncidentList } from "./incidentListPersistence";
import {
  LOCAL_SAVE_DEBOUNCE_MS,
  LOCAL_SAVE_MAX_WAIT_MS,
  loadIncidentMessages,
  loadIncidents,
  saveIncidentMessages,
  saveIncidents,
} from "./incidentStorage";
import type { IncidentThread } from "./types";

/** Web mode keeps the whole state in local storage, saved on a debounce while streaming. */
function useLocalIncidentStorage(
  enabled: boolean,
  incidents: IncidentThread[],
  messagesMap: Record<string, ChatMessage[]>,
) {
  const pendingRef = useRef<{ incidents: IncidentThread[]; messagesMap: Record<string, ChatMessage[]> } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSinceRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingSinceRef.current = null;
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    saveIncidents(pending.incidents);
    saveIncidentMessages(pending.messagesMap);
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

const DESKTOP_LIST_RETRY_MS = 3_000;

/**
 * Loads the incident list into the shared store, and each thread's messages when it is opened. Main
 * persists agent output, and `incidentListPersistence` saves desktop metadata; this saves the few message
 * changes the renderer makes itself.
 */
export function useIncidentPersistence(activeId: string | null) {
  const [desktopStoreMode, setDesktopStoreMode] = useState<"desktop" | "local">(
    () => (hasDesktopIncidentsApi() ? "desktop" : "local"),
  );
  const isDesktopIncidents = desktopStoreMode === "desktop";

  const incidents = useIncidentListStore((state) => state.incidents);
  const [messagesMap, setMessagesMap] = useState<Record<string, ChatMessage[]>>(
    () => {
      if (isDesktopIncidents) return {};
      return loadIncidentMessages();
    },
  );
  // The navbar may load the desktop list too; whichever load succeeds first hydrates the page.
  const loadedFromDesktop = useIncidentListStore((state) => state.loadedFrom === "desktop");
  const [localFallbackHydrated, setLocalFallbackHydrated] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const desktopHydrated = !isDesktopIncidents || loadedFromDesktop || localFallbackHydrated;
  const desktopStoreFallbackLoggedRef = useRef(false);
  const messagesMapRef = useRef(messagesMap);
  const isDesktopIncidentsRef = useRef(isDesktopIncidents);
  messagesMapRef.current = messagesMap;
  isDesktopIncidentsRef.current = isDesktopIncidents;

  useLocalIncidentStorage(!isDesktopIncidents, incidents, messagesMap);

  // Web mode reads local storage on every visit, as before; the navbar may have put the remote list in the store.
  useLayoutEffect(() => {
    if (!hasDesktopIncidentsApi()) useIncidentListStore.getState().setAll(loadIncidents());
  }, []);

  useEffect(() => {
    if (!isDesktopIncidents || desktopHydrated) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = () => { setLoadAttempt((attempt) => attempt + 1); };
    void loadDesktopIncidentList()
      .catch((error: unknown) => {
        if (cancelled) return;
        if (!isMissingIncidentsHandlerError(error)) {
          // A transient failure stays in desktop mode and retries; main still owns the data.
          console.error("Failed to load incidents from desktop store:", error);
          captureIncidentException(error, {
            operation: "loadDesktopIncidents",
            hasDesktopIncidentsApi: true,
          });
          retryTimer = setTimeout(retry, DESKTOP_LIST_RETRY_MS);
          return;
        }
        if (!desktopStoreFallbackLoggedRef.current) {
          desktopStoreFallbackLoggedRef.current = true;
          console.warn(
            "Incidents desktop IPC unavailable, falling back to local storage.",
          );
        }
        useIncidentListStore.getState().setAll(loadIncidents(), "local");
        setMessagesMap(loadIncidentMessages());
        setDesktopStoreMode("local");
        setLocalFallbackHydrated(true);
      });

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [desktopHydrated, isDesktopIncidents, loadAttempt]);

  useEffect(() => {
    if (!isDesktopIncidents || !desktopHydrated || activeId === null) return;
    if (messagesMapRef.current[activeId] !== undefined) return;

    let cancelled = false;
    void loadDesktopIncidentMessages(activeId)
      .then((loaded) => {
        if (cancelled) return;
        // Without a session nothing can still be answering, so an unfinished turn was interrupted.
        const hasSession = useIncidentListStore.getState().incidents.some((incident) => incident.id === activeId && incident.sessionId !== undefined);
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
    messagesMap,
    setMessagesMap,
    appendThreadMessages,
    desktopHydrated,
    isDesktopIncidents,
  };
}
