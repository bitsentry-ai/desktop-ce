import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  AgentSessionState,
  AgentThreadSnapshot,
  AgentThreadTokenUsage,
  ChatMessage,
} from "../../chat/types";
import type { AgentServicePort } from "../../services/contracts";
import {
  applyMessageUpdate,
  getIncidentPreviewFromMessages,
  reconcileMessages,
  updateIncidentTokenUsage,
} from "./incidentNormalize";
import { captureIncidentException } from "./incidentDesktopApi";
import { useIncidentListStore } from "./incidentListStore";
import type { SessionMessagesCache } from "./types";

function findIncidentBySession(sessionId: string) {
  return useIncidentListStore.getState().incidents.find((item) => item.sessionId === sessionId);
}

/** A turn settles on a final, error, or cancel event; the preview changes only then, not on every streamed word. */
function isSettlingEvent(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  const type = (event as { type?: unknown }).type;
  return type === "final" || type === "error" || type === "cancelled";
}

/** Applies agent snapshots and streamed message updates to the incident they belong to. */
export function useIncidentAgentEvents({
  agent,
  activeId,
  setMessagesMap,
  setTokenUsageByIncident,
  setSessionTokenUsage,
}: {
  agent: AgentServicePort;
  activeId: string | null;
  setMessagesMap: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setTokenUsageByIncident: Dispatch<SetStateAction<Record<string, AgentThreadTokenUsage>>>;
  setSessionTokenUsage: Dispatch<SetStateAction<AgentThreadTokenUsage | undefined>>;
}) {
  const pendingEventsRef = useRef<
    Array<{
      sessionId: string;
      sequence: number;
      snapshot?: AgentThreadSnapshot;
      settling: boolean;
    }>
  >([]);
  // Per-incident normalized messages for live sessions; streamed updates are
  // applied against this so unchanged messages keep their identity.
  const sessionMessagesRef = useRef(new Map<string, SessionMessagesCache>());
  const snapshotFetchesRef = useRef(new Set<string>());
  // Sequence of the last payload applied per session. A getSnapshot reply can
  // be overtaken by a newer payload, so older state is never applied over it.
  const lastAppliedSequenceRef = useRef(new Map<string, number>());

  const applySessionMessages = useCallback(
    (
      incidentId: string,
      sessionId: string,
      next: SessionMessagesCache,
      threadState: AgentSessionState,
      tokenUsage: AgentThreadTokenUsage | undefined,
      settled: boolean,
    ) => {
      sessionMessagesRef.current.set(incidentId, next);
      setMessagesMap((prev) =>
        prev[incidentId] === next.messages ? prev : { ...prev, [incidentId]: next.messages },
      );
      if (tokenUsage !== undefined) {
        setTokenUsageByIncident((prev) => updateIncidentTokenUsage(prev, incidentId, tokenUsage));
        if (incidentId === activeId) {
          setSessionTokenUsage((current) => {
            if (tokenUsage.kind === "estimate") return current ?? tokenUsage;
            return JSON.stringify(current) === JSON.stringify(tokenUsage) ? current : tokenUsage;
          });
        }
      }

      const store = useIncidentListStore.getState();
      const incident = store.incidents.find((item) => item.id === incidentId);
      if (incident === undefined) return;
      const preview = settled ? getIncidentPreviewFromMessages(next.messages) : null;
      store.patch(incidentId, {
        state: threadState,
        sessionId: incident.sessionId ?? sessionId,
        ...(preview !== null && { lastMessagePreview: preview }),
      });
    },
    [activeId, setMessagesMap, setSessionTokenUsage, setTokenUsageByIncident],
  );

  const applySnapshotToIncident = useCallback(
    (
      incidentId: string,
      snapshot: AgentThreadSnapshot,
      sequence: number,
      // A getSnapshot reply may repeat the sequence of the last payload.
      allowEqualSequence = false,
      settlingEvent = false,
    ) => {
      const last = lastAppliedSequenceRef.current.get(snapshot.sessionId);
      if (last !== undefined && (allowEqualSequence ? sequence < last : sequence <= last)) return;
      const next = reconcileMessages(sessionMessagesRef.current.get(incidentId), snapshot.messages);
      const settled = settlingEvent || snapshot.threadState !== "RUNNING";
      applySessionMessages(incidentId, snapshot.sessionId, next, snapshot.threadState, snapshot.tokenUsage, settled);
      lastAppliedSequenceRef.current.set(snapshot.sessionId, sequence);
    },
    [applySessionMessages],
  );

  const refetchSessionSnapshot = useCallback(
    (incidentId: string, sessionId: string) => {
      if (snapshotFetchesRef.current.has(sessionId)) return;
      snapshotFetchesRef.current.add(sessionId);
      void agent
        .getSnapshot(sessionId)
        .then((snapshot) => {
          if (snapshot !== null) applySnapshotToIncident(incidentId, snapshot, snapshot.sequence, true);
        })
        .catch((error: unknown) => {
          captureIncidentException(error, { operation: "getSnapshot", source: "stream-resync", incidentId, sessionId });
        })
        .finally(() => {
          snapshotFetchesRef.current.delete(sessionId);
        });
    },
    [agent, applySnapshotToIncident],
  );

  useEffect(() => {
    const unsub = agent.onEvent((payload) => {
      const sid = payload.sessionId;
      const incident = findIncidentBySession(sid);
      if (payload.kind === "message") {
        // Unmapped sessions catch up from the next structural snapshot.
        if (!incident) return;
        const last = lastAppliedSequenceRef.current.get(sid);
        if (last !== undefined && payload.sequence <= last) return;
        const next = applyMessageUpdate(sessionMessagesRef.current.get(incident.id), payload);
        if (next === null) {
          refetchSessionSnapshot(incident.id, sid);
          return;
        }
        applySessionMessages(incident.id, sid, next, payload.threadState, payload.tokenUsage, false);
        lastAppliedSequenceRef.current.set(sid, payload.sequence);
        return;
      }

      const snapshot = payload.snapshot;
      if (!snapshot) return;
      if (!incident) {
        pendingEventsRef.current.push({ sessionId: sid, sequence: payload.sequence, snapshot, settling: isSettlingEvent(payload.event) });
        return;
      }
      applySnapshotToIncident(incident.id, snapshot, payload.sequence, false, isSettlingEvent(payload.event));
    });
    return () => { unsub(); };
  }, [agent, applySessionMessages, applySnapshotToIncident, refetchSessionSnapshot]);

  // Snapshots for a session no thread has yet apply once a thread takes the session.
  const incidents = useIncidentListStore((state) => state.incidents);
  useEffect(() => {
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;

    const remaining: Array<{
      sessionId: string;
      sequence: number;
      snapshot?: AgentThreadSnapshot;
      settling: boolean;
    }> = [];

    for (const pendingEntry of pending) {
      const incident = findIncidentBySession(pendingEntry.sessionId);
      if (!incident || !pendingEntry.snapshot) {
        remaining.push(pendingEntry);
        continue;
      }
      applySnapshotToIncident(incident.id, pendingEntry.snapshot, pendingEntry.sequence, false, pendingEntry.settling);
    }

    pendingEventsRef.current = remaining;
  }, [incidents, applySnapshotToIncident]);

  return { applySnapshotToIncident };
}
