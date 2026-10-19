import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
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
  updateIncidentRow,
  updateIncidentTokenUsage,
} from "./incidentNormalize";
import { captureIncidentException } from "./incidentDesktopApi";
import type { IncidentThread, SessionMessagesCache } from "./types";

/** Applies agent snapshots and streamed message updates to the incident they belong to. */
export function useIncidentAgentEvents({
  agent,
  activeId,
  incidents,
  incidentsRef,
  setIncidents,
  setMessagesMap,
  setTokenUsageByIncident,
  setSessionTokenUsage,
}: {
  agent: AgentServicePort;
  activeId: string | null;
  incidents: IncidentThread[];
  incidentsRef: RefObject<IncidentThread[]>;
  setIncidents: Dispatch<SetStateAction<IncidentThread[]>>;
  setMessagesMap: Dispatch<SetStateAction<Record<string, ChatMessage[]>>>;
  setTokenUsageByIncident: Dispatch<SetStateAction<Record<string, AgentThreadTokenUsage>>>;
  setSessionTokenUsage: Dispatch<SetStateAction<AgentThreadTokenUsage | undefined>>;
}) {
  const pendingEventsRef = useRef<
    Array<{
      sessionId: string;
      sequence: number;
      snapshot?: AgentThreadSnapshot;
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

      const preview = getIncidentPreviewFromMessages(next.messages);
      setIncidents((prev) => updateIncidentRow(prev, incidentId, threadState, sessionId, preview));
    },
    [activeId],
  );

  const applySnapshotToIncident = useCallback(
    (
      incidentId: string,
      snapshot: AgentThreadSnapshot,
      sequence: number,
      // A getSnapshot reply may repeat the sequence of the last payload.
      allowEqualSequence = false,
    ) => {
      const last = lastAppliedSequenceRef.current.get(snapshot.sessionId);
      if (last !== undefined && (allowEqualSequence ? sequence < last : sequence <= last)) return;
      const next = reconcileMessages(sessionMessagesRef.current.get(incidentId), snapshot.messages);
      applySessionMessages(incidentId, snapshot.sessionId, next, snapshot.threadState, snapshot.tokenUsage);
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
      const incident = incidentsRef.current.find(
        (item) => item.sessionId === sid,
      );
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
        applySessionMessages(incident.id, sid, next, payload.threadState, payload.tokenUsage);
        lastAppliedSequenceRef.current.set(sid, payload.sequence);
        return;
      }

      const snapshot = payload.snapshot;
      if (!snapshot) return;
      if (!incident) {
        pendingEventsRef.current.push({ sessionId: sid, sequence: payload.sequence, snapshot });
        return;
      }
      applySnapshotToIncident(incident.id, snapshot, payload.sequence);
    });
    return () => { unsub(); };
  }, [agent, applySessionMessages, applySnapshotToIncident, refetchSessionSnapshot]);

  useEffect(() => {
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;

    const remaining: Array<{
      sessionId: string;
      sequence: number;
      snapshot?: AgentThreadSnapshot;
    }> = [];

    for (const pendingEntry of pending) {
      const incident = incidentsRef.current.find(
        (item) => item.sessionId === pendingEntry.sessionId,
      );
      if (!incident || !pendingEntry.snapshot) {
        remaining.push(pendingEntry);
        continue;
      }
      applySnapshotToIncident(incident.id, pendingEntry.snapshot, pendingEntry.sequence);
    }

    pendingEventsRef.current = remaining;
  }, [incidents, applySnapshotToIncident]);

  return { applySnapshotToIncident };
}
