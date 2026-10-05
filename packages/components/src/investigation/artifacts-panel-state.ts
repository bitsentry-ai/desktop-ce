import { useCallback, useEffect, useRef, useState } from "react";

export type ArtifactsFilter = "all" | "sources" | "runbooks" | "actions" | "deliveries";

/** What the Incident host needs from the Artifacts panel without owning its data. */
export interface ArtifactsPanelSummary {
  /** Sources, runbook results, ticket actions and deliveries together. */
  total: number;
  /** Items that wait for a person: approvals, failed runs, deliveries to review. */
  needYou: number;
  /** Runs and drafts in Runbook results. The first ones of an incident open the panel once. */
  runbookCount: number;
  /** Ticket actions and runbook drafts that await a decision, sorted. The host notices a new one by an ID it has not seen for this incident. */
  pendingIds: string[];
}
export const EMPTY_ARTIFACTS_SUMMARY: ArtifactsPanelSummary = { total: 0, needYou: 0, runbookCount: 0, pendingIds: [] };
const summaryKey = (summary: ArtifactsPanelSummary) => [summary.total, summary.needYou, summary.runbookCount, summary.pendingIds.join(",")].join("|");

export interface ArtifactsPanelState {
  open: boolean;
  /** True when the engineer opened the panel; an automatic opening must not move focus away from the chat. */
  openedByUser: boolean;
  filter: ArtifactsFilter;
  summary: ArtifactsPanelSummary;
  toggle(): void;
  close(): void;
  setFilter(filter: ArtifactsFilter): void;
  reportSummary(summary: ArtifactsPanelSummary): void;
}

interface PanelUiState { incidentId: string | null; open: boolean; openedByUser: boolean; filter: ArtifactsFilter }
const closedPanel = (incidentId: string | null): PanelUiState => ({ incidentId, open: false, openedByUser: false, filter: "all" });
const forIncident = (state: PanelUiState, incidentId: string | null) => (state.incidentId === incidentId ? state : closedPanel(incidentId));

/**
 * The one open state of the Artifacts panel at the Incident host. Switching incidents starts closed. The panel opens
 * by itself, once, in two cases: when the incident first has runbook results, and when a ticket action or a runbook
 * draft arrives that was not seen before. Polling the same item again, or a panel the engineer dismissed, never
 * reopens it. A panel that opens by itself shows everything, so what needs the engineer is at the top.
 */
export function useArtifactsPanelState({ incidentId }: { incidentId: string | null }): ArtifactsPanelState {
  const [ui, setUi] = useState<PanelUiState>(() => closedPanel(incidentId));
  const [summaryState, setSummaryState] = useState<{ incidentId: string | null; summary: ArtifactsPanelSummary }>({ incidentId, summary: EMPTY_ARTIFACTS_SUMMARY });
  const seenPendingRef = useRef<{ incidentId: string | null; ids: Set<string> }>({ incidentId, ids: new Set() });
  const resultsOpenedRef = useRef<string | null>(null);
  const current = forIncident(ui, incidentId);
  const summary = summaryState.incidentId === incidentId ? summaryState.summary : EMPTY_ARTIFACTS_SUMMARY;

  const update = useCallback((patch: Partial<Omit<PanelUiState, "incidentId">>) => {
    setUi((previous) => ({ ...forIncident(previous, incidentId), ...patch }));
  }, [incidentId]);
  const reportSummary = useCallback((next: ArtifactsPanelSummary) => {
    setSummaryState((previous) => (previous.incidentId === incidentId && summaryKey(previous.summary) === summaryKey(next) ? previous : { incidentId, summary: next }));
  }, [incidentId]);
  const toggle = useCallback(() => {
    setUi((previous) => {
      const state = forIncident(previous, incidentId);
      return state.open ? { ...state, open: false } : { ...state, open: true, openedByUser: true };
    });
  }, [incidentId]);
  const close = useCallback(() => { update({ open: false }); }, [update]);
  const setFilter = useCallback((filter: ArtifactsFilter) => { update({ filter }); }, [update]);

  useEffect(() => {
    if (seenPendingRef.current.incidentId !== incidentId) seenPendingRef.current = { incidentId, ids: new Set() };
    const seen = seenPendingRef.current.ids;
    const arrived = summary.pendingIds.filter((id) => !seen.has(id));
    arrived.forEach((id) => seen.add(id));
    const firstResults = summary.runbookCount > 0 && resultsOpenedRef.current !== incidentId;
    if (firstResults) resultsOpenedRef.current = incidentId;
    if ((arrived.length === 0 && !firstResults) || current.open) return;
    update({ open: true, openedByUser: false, filter: "all" });
  }, [current.open, incidentId, summary.pendingIds, summary.runbookCount, update]);

  return { open: current.open, openedByUser: current.openedByUser, filter: current.filter, summary, toggle, close, setFilter, reportSummary };
}
