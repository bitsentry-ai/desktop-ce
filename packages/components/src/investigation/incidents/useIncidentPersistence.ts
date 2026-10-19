import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../chat/types";
import {
  captureIncidentException,
  hasDesktopIncidentsApi,
  isMissingIncidentsHandlerError,
  loadDesktopIncidentState,
  saveDesktopIncidentState,
} from "./incidentDesktopApi";
import {
  DESKTOP_SYNC_DEBOUNCE_MS,
  DESKTOP_SYNC_MAX_WAIT_MS,
  loadIncidentMessages,
  loadIncidents,
  saveIncidentMessages,
  saveIncidents,
} from "./incidentStorage";
import type { IncidentThread } from "./types";

/** Loads incidents and messages from the desktop store or local storage and saves them back. */
export function useIncidentPersistence() {
  const [desktopStoreMode, setDesktopStoreMode] = useState<"desktop" | "local">(
    () => {
      if (hasDesktopIncidentsApi()) return "desktop";
      return "local";
    },
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
  const desktopSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const desktopSyncPendingSinceRef = useRef<number | null>(null);
  const desktopStoreFallbackLoggedRef = useRef(false);
  const latestDesktopStateRef = useRef<{
    incidents: IncidentThread[];
    messagesMap: Record<string, ChatMessage[]>;
  }>({
    incidents: [],
    messagesMap: {},
  });
  const desktopHydratedRef = useRef(desktopHydrated);
  const isDesktopIncidentsRef = useRef(isDesktopIncidents);

  latestDesktopStateRef.current = { incidents, messagesMap };
  desktopHydratedRef.current = desktopHydrated;
  isDesktopIncidentsRef.current = isDesktopIncidents;

  useEffect(() => {
    if (!isDesktopIncidents) return;

    let cancelled = false;
    void loadDesktopIncidentState()
      .then((snapshot) => {
        if (cancelled) return;
        setIncidents(snapshot.incidents);
        setMessagesMap(snapshot.messagesMap);
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
          if (!cancelled) {
            setIncidents(loadIncidents());
            setMessagesMap(loadIncidentMessages());
            setDesktopStoreMode("local");
            setDesktopHydrated(true);
          }
          return;
        }
        console.error("Failed to load incidents from desktop store:", error);
        captureIncidentException(error, {
          operation: "loadDesktopIncidentState",
          hasDesktopIncidentsApi: true,
        });
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
    if (isDesktopIncidents && !desktopHydrated) return;

    // Streaming changes messagesMap many times a second, so local storage,
    // listeners and the desktop store all save on the debounce.
    if (desktopSyncTimerRef.current != null) {
      clearTimeout(desktopSyncTimerRef.current);
    }
    const now = Date.now();
    desktopSyncPendingSinceRef.current ??= now;
    const delay = Math.min(
      DESKTOP_SYNC_DEBOUNCE_MS,
      Math.max(0, desktopSyncPendingSinceRef.current + DESKTOP_SYNC_MAX_WAIT_MS - now),
    );
    desktopSyncTimerRef.current = setTimeout(() => {
      desktopSyncTimerRef.current = null;
      desktopSyncPendingSinceRef.current = null;
      saveIncidents(incidents);
      saveIncidentMessages(messagesMap);
      window.dispatchEvent(new CustomEvent("bitsentry:incidents-updated"));
      if (!isDesktopIncidents) return;
      void saveDesktopIncidentState(incidents, messagesMap)
        .then(() => {
          window.dispatchEvent(
            new CustomEvent("bitsentry:incidents-updated"),
          );
        })
        .catch((error: unknown) => {
          if (isMissingIncidentsHandlerError(error)) {
            if (!desktopStoreFallbackLoggedRef.current) {
              desktopStoreFallbackLoggedRef.current = true;
              console.warn(
                "Incidents desktop IPC unavailable, falling back to local storage.",
              );
            }
            setDesktopStoreMode("local");
            return;
          }
          console.error("Failed to save incidents to desktop store:", error);
          captureIncidentException(error, {
            operation: "saveDesktopIncidentState",
            incidentCount: incidents.length,
            messageMapCount: Object.keys(messagesMap).length,
          });
        });
    }, delay);
  }, [desktopHydrated, incidents, isDesktopIncidents, messagesMap]);

  useEffect(() => {
    // Flush a pending debounced save on unmount and when the window goes away.
    const flushPendingDesktopSync = () => {
      if (desktopSyncTimerRef.current == null) return;
      clearTimeout(desktopSyncTimerRef.current);
      desktopSyncTimerRef.current = null;
      desktopSyncPendingSinceRef.current = null;

      const {
        incidents: latestIncidents,
        messagesMap: latestMessagesMap,
      } = latestDesktopStateRef.current;

      saveIncidents(latestIncidents);
      window.dispatchEvent(new CustomEvent("bitsentry:incidents-updated"));
      saveIncidentMessages(latestMessagesMap);

      if (
        isDesktopIncidentsRef.current &&
        desktopHydratedRef.current
      ) {
        void saveDesktopIncidentState(latestIncidents, latestMessagesMap)
          .catch((error: unknown) => {
            if (isMissingIncidentsHandlerError(error)) {
              if (!desktopStoreFallbackLoggedRef.current) {
                desktopStoreFallbackLoggedRef.current = true;
                console.warn(
                  "Incidents desktop IPC unavailable, falling back to local storage.",
                );
              }
              return;
            }
            console.error(
              "Failed to flush incidents to desktop store on cleanup:",
              error,
            );
            captureIncidentException(error, {
              operation: "saveDesktopIncidentState:cleanup",
              incidentCount: latestIncidents.length,
              messageMapCount: Object.keys(latestMessagesMap).length,
            });
          });
      }
    };
    window.addEventListener("pagehide", flushPendingDesktopSync);
    return () => {
      window.removeEventListener("pagehide", flushPendingDesktopSync);
      flushPendingDesktopSync();
    };
  }, []);

  return {
    incidents,
    setIncidents,
    messagesMap,
    setMessagesMap,
    desktopHydrated,
    isDesktopIncidents,
  };
}
