import { useCallback, useEffect, useId, useMemo, useRef, useState, type ElementType, type KeyboardEvent } from "react";
import { Link2, Plug, Ticket, Webhook, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation, IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import { useBitsentryServices } from "../services/context";
import { integrationErrorKey } from "./integration-error";
import { IntegrationActionsView, type IntegrationOperationsPort } from "./IntegrationActionsView";
import { IntegrationDeliveriesView, needsReview, type IntegrationDelivery, type IntegrationDeliveriesPort } from "./IntegrationDeliveriesView";
import { IntegrationSourcesView, type IntegrationResourcesPort } from "./IntegrationSourcesView";

export type IntegrationsRailView = "sources" | "actions" | "deliveries";

/** What the Incident host needs from the rail without owning its data: header counts and the requests awaiting approval. */
export interface IntegrationsRailSummary {
  resourceCount: number;
  selectedCount: number;
  operationCount: number;
  pendingCount: number;
  deliveryCount: number;
  /** Deliveries that failed or whose outcome is unknown. They raise a count on the header entry point and never open the rail. */
  attentionCount: number;
  /** Operations awaiting approval, sorted; the host notices a new proposal by an ID it has not seen for this incident. */
  pendingIds: string[];
}
export const EMPTY_INTEGRATIONS_SUMMARY: IntegrationsRailSummary = { resourceCount: 0, selectedCount: 0, operationCount: 0, pendingCount: 0, deliveryCount: 0, attentionCount: 0, pendingIds: [] };
const summaryKey = (summary: IntegrationsRailSummary) =>
  [summary.resourceCount, summary.selectedCount, summary.operationCount, summary.pendingCount, summary.deliveryCount, summary.attentionCount, summary.pendingIds.join(",")].join("|");

export interface IntegrationsRailState {
  open: boolean;
  view: IntegrationsRailView;
  /** True when the engineer opened the rail; an automatic opening must not move focus away from the chat. */
  openedByUser: boolean;
  summary: IntegrationsRailSummary;
  toggle(view: IntegrationsRailView): void;
  close(): void;
  setView(view: IntegrationsRailView): void;
  reportSummary(summary: IntegrationsRailSummary): void;
}

interface RailUiState { incidentId: string | null; open: boolean; view: IntegrationsRailView; openedByUser: boolean }
const closedRail = (incidentId: string | null): RailUiState => ({ incidentId, open: false, view: "sources", openedByUser: false });
const forIncident = (state: RailUiState, incidentId: string | null) => (state.incidentId === incidentId ? state : closedRail(incidentId));

/**
 * Coordinates the integrations rail with the Runbook rail at the Incident host: one right panel is visible at a time,
 * switching incidents starts closed, and a proposal that was not seen before opens Ticket actions once, only while no
 * rail is open. Polling the same proposal again, or a rail the engineer dismissed, never reopens it.
 */
export function useIntegrationsRailState({ incidentId, runbookRailOpen, closeRunbookRail }: {
  incidentId: string | null;
  runbookRailOpen: boolean;
  closeRunbookRail(): void;
}): IntegrationsRailState {
  const [ui, setUi] = useState<RailUiState>(() => closedRail(incidentId));
  const [summaryState, setSummaryState] = useState<{ incidentId: string | null; summary: IntegrationsRailSummary }>({ incidentId, summary: EMPTY_INTEGRATIONS_SUMMARY });
  const seenPendingRef = useRef<{ incidentId: string | null; ids: Set<string> }>({ incidentId, ids: new Set() });
  const current = forIncident(ui, incidentId);
  const summary = summaryState.incidentId === incidentId ? summaryState.summary : EMPTY_INTEGRATIONS_SUMMARY;

  const update = useCallback((patch: Partial<Omit<RailUiState, "incidentId">>) => {
    setUi((previous) => ({ ...forIncident(previous, incidentId), ...patch }));
  }, [incidentId]);
  const reportSummary = useCallback((next: IntegrationsRailSummary) => {
    setSummaryState((previous) => (previous.incidentId === incidentId && summaryKey(previous.summary) === summaryKey(next) ? previous : { incidentId, summary: next }));
  }, [incidentId]);
  const toggle = useCallback((view: IntegrationsRailView) => {
    setUi((previous) => {
      const state = forIncident(previous, incidentId);
      if (state.open && state.view === view) return { ...state, open: false };
      return { ...state, open: true, view, openedByUser: true };
    });
    closeRunbookRail();
  }, [closeRunbookRail, incidentId]);
  const close = useCallback(() => { update({ open: false }); }, [update]);
  const setView = useCallback((view: IntegrationsRailView) => { update({ view }); }, [update]);

  useEffect(() => {
    if (runbookRailOpen) update({ open: false });
  }, [runbookRailOpen, update]);
  useEffect(() => {
    if (seenPendingRef.current.incidentId !== incidentId) seenPendingRef.current = { incidentId, ids: new Set() };
    const seen = seenPendingRef.current.ids;
    const arrived = summary.pendingIds.filter((id) => !seen.has(id));
    if (arrived.length === 0) return;
    arrived.forEach((id) => seen.add(id));
    if (current.open || runbookRailOpen) return;
    update({ open: true, view: "actions", openedByUser: false });
  }, [current.open, incidentId, runbookRailOpen, summary.pendingIds, update]);

  return { open: current.open, view: current.view, openedByUser: current.openedByUser, summary, toggle, close, setView, reportSummary };
}

/** The desktop ports for the rail, from whichever plugin capabilities this client exposes. */
export function useDesktopIntegrationPorts(): { resources?: IntegrationResourcesPort; operations?: IntegrationOperationsPort } {
  const { plugins } = useBitsentryServices();
  return useMemo(() => ({
    resources: plugins?.listResources ? { list: plugins.listResources.bind(plugins), select: plugins.selectResource?.bind(plugins), refresh: plugins.refreshResource?.bind(plugins) } : undefined,
    operations: plugins?.listOperations && plugins.approveOperation && plugins.cancelOperation ? {
      renew: plugins.renewOperation?.bind(plugins), reconcile: plugins.reconcileOperation?.bind(plugins),
      list: plugins.listOperations.bind(plugins), approve: plugins.approveOperation.bind(plugins), cancel: plugins.cancelOperation.bind(plugins),
    } : undefined,
  }), [plugins]);
}

function CountPill({ count, pending, attention = 0 }: { count: number; pending: number; attention?: number }) {
  const { t } = useTranslation();
  const amber = "rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400";
  if (pending > 0) return <span className={amber}>{t("incidents.integrationRail.pendingShort", { pending })}</span>;
  if (attention > 0) return <span className={amber}>{t("incidents.integrationRail.attentionShort", { attention })}</span>;
  return <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">{count}</span>;
}

function RailTrigger({ active, icon: Icon, label, title, count, pending, attention = 0, onClick }: {
  active: boolean; icon: ElementType; label: string; title: string; count: number; pending: number; attention?: number; onClick(): void;
}) {
  return <button type="button" aria-pressed={active} title={title} onClick={onClick}
    className={cn("flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "bg-muted text-foreground" : "hover:bg-muted")}>
    <Icon size={12} aria-hidden="true" />
    {label}
    <CountPill count={count} pending={pending} attention={attention} />
  </button>;
}

/** The header entry points: Sources and Ticket actions, each with its count, styled like the Runbook Results button. */
export function IntegrationsRailTriggers({ state }: { state: IntegrationsRailState }) {
  const { t } = useTranslation();
  const { summary } = state;
  const sourcesActive = state.open && state.view === "sources";
  const actionsActive = state.open && state.view === "actions";
  const deliveriesActive = state.open && state.view === "deliveries";
  return <>
    {(summary.resourceCount > 0 || sourcesActive) && <RailTrigger active={sourcesActive} icon={Link2} label={t("incidents.integrationRail.sources")}
      title={t("incidents.integrationRail.sourcesSubtitle", { linked: summary.resourceCount, selected: summary.selectedCount })}
      count={summary.resourceCount} pending={0} onClick={() => { state.toggle("sources"); }} />}
    {(summary.operationCount > 0 || actionsActive) && <RailTrigger active={actionsActive} icon={Ticket} label={t("incidents.integrationRail.ticketActions")}
      title={t("incidents.integrationRail.actionsSubtitle", { total: summary.operationCount, pending: summary.pendingCount })}
      count={summary.operationCount} pending={summary.pendingCount} onClick={() => { state.toggle("actions"); }} />}
    {(summary.deliveryCount > 0 || deliveriesActive) && <RailTrigger active={deliveriesActive} icon={Webhook} label={t("incidents.integrationRail.deliveries")}
      title={t("incidents.integrationRail.deliveriesSubtitle", { total: summary.deliveryCount, attention: summary.attentionCount })}
      count={summary.deliveryCount} pending={0} attention={summary.attentionCount} onClick={() => { state.toggle("deliveries"); }} />}
  </>;
}

export function usePolledRows<T>(threadId: string, port: { list(threadId: string): Promise<T[]> } | undefined, intervalMs: number) {
  const [rows, setRows] = useState<T[]>([]);
  const [failed, setFailed] = useState(false);
  const activeRef = useRef(true);
  const latestRequestRef = useRef(0);
  const refresh = useCallback(async () => {
    if (port === undefined) return;
    // Refreshes overlap (the timer, a decision, a recovery). Only the newest answer may replace what is shown, or a slow
    // older one would bring back a status that has already moved on, together with its controls.
    const request = ++latestRequestRef.current;
    try {
      const next = await port.list(threadId);
      if (activeRef.current && request === latestRequestRef.current) { setRows(next); setFailed(false); }
    } catch {
      if (activeRef.current && request === latestRequestRef.current) setFailed(true);
    }
  }, [port, threadId]);
  useEffect(() => {
    activeRef.current = true;
    // Rows belong to one conversation: show nothing from the previous one while the new list loads.
    setRows([]);
    setFailed(false);
    void refresh();
    const timer = setInterval(() => { void refresh(); }, intervalMs);
    return () => { activeRef.current = false; clearInterval(timer); };
  }, [intervalMs, refresh]);
  const fail = useCallback(() => { setFailed(true); }, []);
  return { rows, failed, refresh, fail };
}

/** One source action at a time: a select or a refresh. A failure becomes the recovery message for its cause; the next attempt clears it. */
export function useSourceActions(resources: IntegrationResourcesPort | undefined, reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void action().then(reload).catch((failure: unknown) => { setError(integrationErrorKey(failure)); }).finally(() => { setBusy(false); });
  };
  return {
    busy, error,
    select: resources?.select === undefined ? undefined : (resource: IntegrationResource, selected: boolean) => { run(() => resources.select!(resource, selected)); },
    refresh: resources?.refresh === undefined ? undefined : (resource: IntegrationResource) => { run(() => resources.refresh!(resource)); },
  };
}

function ViewTab({ id, panelId, active, label, count, pending, attention = 0, onSelect }: {
  id: string; panelId: string; active: boolean; label: string; count: number; pending: number; attention?: number; onSelect(): void;
}) {
  return <button type="button" role="tab" id={id} aria-selected={active} aria-controls={panelId} onClick={onSelect}
    className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active ? "border-primary bg-primary/5 text-foreground" : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground")}>
    {label}
    <CountPill count={count} pending={pending} attention={attention} />
  </button>;
}

/**
 * The integrations rail beside the Incident chat, styled like the Runbook artifact rail: linked sources in one view,
 * ticket actions with their approvals in the other. Both views stay mounted, so switching keeps a half-filled review or
 * a selected operation. The host keys it by incident and decides when it is open.
 */
export default function IncidentIntegrationsRail({ isOpen, view, focusOnOpen = false, onViewChange, onClose, threadId, disabled, resources, operations, deliveries, onSummaryChange }: {
  isOpen: boolean;
  view: IntegrationsRailView;
  focusOnOpen?: boolean;
  onViewChange(view: IntegrationsRailView): void;
  onClose(): void;
  threadId: string;
  disabled: boolean;
  resources?: IntegrationResourcesPort;
  operations?: IntegrationOperationsPort;
  deliveries?: IntegrationDeliveriesPort;
  onSummaryChange?(summary: IntegrationsRailSummary): void;
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const sources = usePolledRows<IntegrationResource>(threadId, resources, 5000);
  const actions = usePolledRows<IntegrationOperation>(threadId, operations, 2500);
  const deliveryRows = usePolledRows<IntegrationDelivery>(threadId, deliveries, 5000);
  const selectedCount = sources.rows.filter((row) => row.selected === true).length;
  const pendingIds = useMemo(() => actions.rows.filter((row) => row.status === "proposed").map((row) => row.id).sort(), [actions.rows]);
  const attentionCount = deliveryRows.rows.filter(needsReview).length;
  const summary = useMemo<IntegrationsRailSummary>(() => ({
    resourceCount: sources.rows.length, selectedCount, operationCount: actions.rows.length, pendingCount: pendingIds.length,
    deliveryCount: deliveryRows.rows.length, attentionCount, pendingIds,
  }), [actions.rows.length, attentionCount, deliveryRows.rows.length, pendingIds, selectedCount, sources.rows.length]);
  useEffect(() => { onSummaryChange?.(summary); }, [onSummaryChange, summary]);

  useEffect(() => {
    const aside = asideRef.current;
    if (aside === null) return;
    if (isOpen) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !aside.contains(active)) returnFocusRef.current = active;
      if (focusOnOpen) aside.focus({ preventScroll: true });
      return;
    }
    if (aside.contains(document.activeElement)) returnFocusRef.current?.focus();
  }, [focusOnOpen, isOpen]);

  const sourceActions = useSourceActions(resources, sources.refresh);
  const tabId = (name: IntegrationsRailView) => `${baseId}-${name}-tab`;
  const panelId = (name: IntegrationsRailView) => `${baseId}-${name}-panel`;
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
  };
  const views: IntegrationsRailView[] = deliveries === undefined ? ["sources", "actions"] : ["sources", "actions", "deliveries"];
  const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = views[(views.indexOf(view) + step + views.length) % views.length]!;
    event.preventDefault();
    onViewChange(next);
    document.getElementById(tabId(next))?.focus();
  };
  const subtitles: Record<IntegrationsRailView, string> = {
    sources: t("incidents.integrationRail.sourcesSubtitle", { linked: summary.resourceCount, selected: summary.selectedCount }),
    actions: t("incidents.integrationRail.actionsSubtitle", { total: summary.operationCount, pending: summary.pendingCount }),
    deliveries: t("incidents.integrationRail.deliveriesSubtitle", { total: summary.deliveryCount, attention: summary.attentionCount }),
  };
  const subtitle = subtitles[view];

  return <aside ref={asideRef} tabIndex={-1} data-tour="incidents-integrations-rail" aria-label={t("incidents.integrationRail.title")} aria-hidden={!isOpen} inert={!isOpen} onKeyDown={handleKeyDown}
    className={cn("absolute inset-y-0 right-0 z-20 flex w-full max-w-[430px] flex-col border-l border-border bg-background/95 shadow-2xl outline-none backdrop-blur transition-transform duration-300", isOpen ? "translate-x-0" : "translate-x-full")}>
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex size-9 items-center justify-center rounded-2xl border border-border bg-muted/20"><Plug size={16} className="text-muted-foreground" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{t("incidents.integrationRail.title")}</div>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
      </div>
      <button type="button" onClick={onClose} aria-label={t("incidents.integrationRail.close")}
        className="flex size-8 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <X size={14} />
      </button>
    </div>
    <div role="tablist" aria-label={t("incidents.integrationRail.views")} onKeyDown={handleTabListKeyDown} className="flex gap-1 border-b border-border px-4 py-2">
      <ViewTab id={tabId("sources")} panelId={panelId("sources")} active={view === "sources"} label={t("incidents.integrationRail.sources")} count={summary.resourceCount} pending={0} onSelect={() => { onViewChange("sources"); }} />
      <ViewTab id={tabId("actions")} panelId={panelId("actions")} active={view === "actions"} label={t("incidents.integrationRail.ticketActions")} count={summary.operationCount} pending={summary.pendingCount} onSelect={() => { onViewChange("actions"); }} />
      {deliveries !== undefined && <ViewTab id={tabId("deliveries")} panelId={panelId("deliveries")} active={view === "deliveries"} label={t("incidents.integrationRail.deliveries")} count={summary.deliveryCount} pending={0} attention={summary.attentionCount} onSelect={() => { onViewChange("deliveries"); }} />}
    </div>
    <div role="tabpanel" id={panelId("sources")} aria-labelledby={tabId("sources")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", view === "sources" ? "block" : "hidden")}>
      <IntegrationSourcesView threadId={threadId} rows={sources.rows} failed={sources.failed} disabled={disabled || sourceActions.busy} onSelect={sourceActions.select} onRefresh={sourceActions.refresh} actionError={sourceActions.error} />
    </div>
    <div role="tabpanel" id={panelId("actions")} aria-labelledby={tabId("actions")} className={cn("min-h-0 flex-1 flex-col", view === "actions" ? "flex" : "hidden")}>
      {operations === undefined
        ? <p className="px-4 py-4 text-sm text-muted-foreground">{t("incidents.integrationRail.noActions")}</p>
        : <IntegrationActionsView threadId={threadId} rows={actions.rows} failed={actions.failed} disabled={disabled} service={operations} onRefresh={actions.refresh} />}
    </div>
    {deliveries !== undefined && <div role="tabpanel" id={panelId("deliveries")} aria-labelledby={tabId("deliveries")} className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", view === "deliveries" ? "block" : "hidden")}>
      <IntegrationDeliveriesView threadId={threadId} rows={deliveryRows.rows} failed={deliveryRows.failed} disabled={disabled} service={deliveries} onRefresh={deliveryRows.refresh} />
    </div>}
  </aside>;
}
