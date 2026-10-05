import { useEffect, useId, useMemo, useRef, useState, type ElementType, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { AlertTriangle, BookOpen, ChevronDown, FileText, Layers, Link2, Ticket, Webhook, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation, IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import type { ArtifactsFilter, ArtifactsPanelState, ArtifactsPanelSummary } from "./artifacts-panel-state";
import { RunbookResultsView, useRunbookResults, type IncidentArtifactsMessage } from "./IncidentArtifactsRail";
import { usePolledRows, useSourceActions } from "./IncidentIntegrationsRail";
import { orderOperations, useOperationDecisions, type IntegrationOperationsPort } from "./IntegrationActionsView";
import { AttentionRow, DeliveryItemCard, OperationCard, useOpenCards } from "./IntegrationArtifactCards";
import { needsReview, orderDeliveries, type IntegrationDelivery, type IntegrationDeliveriesPort } from "./IntegrationDeliveriesView";
import { IntegrationSourcesView, useExecutionPanelState, type IntegrationResourcesPort } from "./IntegrationSourcesView";
import { KnowledgeExecutionPanel } from "./KnowledgeExecutionPanel";

const COUNT_PILL = "rounded-full bg-muted px-1.5 py-0.5 text-[10px]";
const AMBER_PILL = "rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400";
const EMPTY_BOX = "rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground";
const ERROR_BOX = "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive";

/** The one header entry point of the Incident: every artifact in the count, and how many of them need the engineer. */
export function ArtifactsPanelTrigger({ state }: { state: ArtifactsPanelState }) {
  const { t } = useTranslation();
  const { summary } = state;
  if (summary.total === 0 && !state.open) return null;
  return <button type="button" aria-pressed={state.open} onClick={state.toggle}
    className={cn("flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", state.open ? "bg-muted text-foreground" : "hover:bg-muted")}>
    <Layers size={12} aria-hidden="true" />
    {t("incidents.artifactsPanel.title")}
    <span className={COUNT_PILL}>{summary.total}</span>
    {summary.needYou > 0 && <span className={AMBER_PILL}>{t("incidents.artifactsPanel.needYou", { count: summary.needYou })}</span>}
  </button>;
}

function FilterChip({ active, label, count, onSelect }: { active: boolean; label: string; count: number; onSelect(): void }) {
  return <button type="button" aria-pressed={active} onClick={onSelect}
    className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      active ? "border-primary bg-primary/5 text-foreground" : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground")}>
    {label}
    <span className={COUNT_PILL}>{count}</span>
  </button>;
}

function SectionHeading({ icon: Icon, label, count }: { icon: ElementType; label: string; count: number }) {
  return <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
    <Icon size={12} aria-hidden="true" />
    <h3>{label}</h3>
    <span className={cn(COUNT_PILL, "normal-case tracking-normal")}>{count}</span>
    <span aria-hidden="true" className="h-px flex-1 bg-border" />
  </div>;
}

/** A section stays mounted while another filter is chosen, so a half-filled review or a selected run is still there when it comes back. */
function Section({ label, visible, fill = false, sectionRef, children }: { label: string; visible: boolean; fill?: boolean; sectionRef?: Ref<HTMLElement>; children: ReactNode }) {
  return <section ref={sectionRef} aria-label={label} hidden={!visible} className={visible && fill ? "flex min-h-0 flex-1 flex-col" : undefined}>{children}</section>;
}

const operationCardId = (id: string) => `operation:${id}`;
const deliveryCardId = (id: string) => `delivery:${id}`;

/**
 * Every artifact of one Incident in a single panel beside the chat: the sources the agent read, the runbook results, the
 * ticket actions and the webhook deliveries. What waits for the engineer is on top, and the filters narrow it to one kind.
 * The host decides when it is open and keys it by incident; its data, its polling and its approvals are those of the
 * rails it replaces.
 */
export default function IncidentArtifactsPanel({ isOpen, filter, focusOnOpen = false, onFilterChange, onClose, threadId, disabled, messages, sessionId, onRevisionRequested, resources, operations, deliveries, onSummaryChange }: {
  isOpen: boolean;
  filter: ArtifactsFilter;
  focusOnOpen?: boolean;
  onFilterChange(filter: ArtifactsFilter): void;
  onClose(): void;
  threadId: string;
  disabled: boolean;
  messages: IncidentArtifactsMessage[];
  sessionId?: string | null;
  onRevisionRequested?(requestedEdit: string): void;
  resources?: IntegrationResourcesPort;
  operations?: IntegrationOperationsPort;
  deliveries?: IntegrationDeliveriesPort;
  onSummaryChange?(summary: ArtifactsPanelSummary): void;
}) {
  const { t } = useTranslation();
  const footerId = useId();
  const asideRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const runbookSectionRef = useRef<HTMLElement>(null);
  const [footerOpen, setFooterOpen] = useState(false);

  const sources = usePolledRows<IntegrationResource>(threadId, resources, 5000);
  const actions = usePolledRows<IntegrationOperation>(threadId, operations, 2500);
  const deliveryRows = usePolledRows<IntegrationDelivery>(threadId, deliveries, 5000);
  const runbookResults = useRunbookResults({ messages, incidentId: threadId, sessionId });
  const sourceActions = useSourceActions(resources, sources.refresh);
  const decisions = useOperationDecisions({ threadId, service: operations, onRefresh: actions.refresh });
  const execution = useExecutionPanelState(sources.rows);
  const cards = useOpenCards();
  const { summary: runbookSummary } = runbookResults;

  const operationRows = useMemo(() => orderOperations(actions.rows), [actions.rows]);
  const deliveryList = useMemo(() => orderDeliveries(deliveryRows.rows), [deliveryRows.rows]);
  const pendingOperations = useMemo(() => operationRows.filter((row) => row.status === "proposed"), [operationRows]);
  const reviewDeliveries = useMemo(() => deliveryList.filter(needsReview), [deliveryList]);
  const needYou = pendingOperations.length + reviewDeliveries.length + runbookSummary.failedRuns.length + runbookSummary.pendingDrafts.length;
  const total = sources.rows.length + runbookSummary.count + operationRows.length + deliveryRows.rows.length;
  const pendingIds = useMemo(
    () => [...pendingOperations.map((row) => `operation:${row.id}`), ...runbookSummary.pendingDrafts.map((draft) => `draft:${draft.proposalId}`)].sort(),
    [pendingOperations, runbookSummary.pendingDrafts],
  );
  const summary = useMemo<ArtifactsPanelSummary>(() => ({ total, needYou, runbookCount: runbookSummary.count, pendingIds }), [needYou, pendingIds, runbookSummary.count, total]);
  useEffect(() => { onSummaryChange?.(summary); }, [onSummaryChange, summary]);

  // A request that just arrived is opened, so the exact change is in front of the engineer before anything is approved.
  const knownOperationsRef = useRef(new Set<string>());
  const { show: showCard } = cards;
  useEffect(() => {
    const known = knownOperationsRef.current;
    const arrived = operationRows.filter((row) => !known.has(row.id));
    arrived.forEach((row) => known.add(row.id));
    const awaiting = arrived.find((row) => row.status === "proposed");
    if (awaiting !== undefined) showCard(operationCardId(awaiting.id));
  }, [operationRows, showCard]);

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
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
  };

  const scrollToRunbooks = () => { runbookSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); };
  const reviewDraft = (proposalId: string) => { runbookResults.selectDraft(proposalId); scrollToRunbooks(); };
  const viewRun = (key: string) => { runbookResults.selectRun(key); scrollToRunbooks(); };

  // In "All" what needs the engineer is above and is not listed again in its section; a single-kind filter lists everything of that kind.
  const everything = filter === "all";
  const sectionOperations = everything ? operationRows.filter((row) => row.status !== "proposed") : operationRows;
  const sectionDeliveries = everything ? deliveryList.filter((row) => !needsReview(row)) : deliveryList;
  const showNeedsYou = everything && needYou > 0;
  const showSources = filter === "sources" || (everything && (sources.rows.length > 0 || sources.failed));
  const showRunbooks = filter === "runbooks" || (everything && runbookSummary.count > 0);
  const showActions = filter === "actions" || (everything && (sectionOperations.length > 0 || actions.failed || decisions.failed));
  const showDeliveries = deliveries !== undefined && (filter === "deliveries" || (everything && (sectionDeliveries.length > 0 || deliveryRows.failed)));
  const fillBody = filter === "runbooks";

  const operationCard = (row: IntegrationOperation) => operations === undefined ? null
    : <OperationCard key={row.id} row={row} open={cards.isOpen(operationCardId(row.id))} onToggle={() => { cards.toggle(operationCardId(row.id)); }} disabled={disabled} decisions={decisions} service={operations} onRefresh={actions.refresh} />;
  const deliveryCard = (row: IntegrationDelivery) => deliveries === undefined ? null
    : <DeliveryItemCard key={row.id} row={row} open={cards.isOpen(deliveryCardId(row.id))} onToggle={() => { cards.toggle(deliveryCardId(row.id)); }} threadId={threadId} disabled={disabled} service={deliveries} onRefresh={deliveryRows.refresh} />;

  return <aside ref={asideRef} tabIndex={-1} data-tour="incidents-artifacts-rail" aria-label={t("incidents.artifactsPanel.title")} aria-hidden={!isOpen} inert={!isOpen} onKeyDown={handleKeyDown}
    className={cn("absolute inset-y-0 right-0 z-20 flex w-full max-w-[430px] flex-col border-l border-border bg-background/95 shadow-2xl outline-none backdrop-blur transition-transform duration-300", isOpen ? "translate-x-0" : "translate-x-full")}>
    <div className="flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex size-9 items-center justify-center rounded-2xl border border-border bg-muted/20"><Layers size={16} className="text-muted-foreground" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{t("incidents.artifactsPanel.title")}</div>
        <div className="truncate text-xs text-muted-foreground">
          {t("incidents.artifactsPanel.itemCount", { count: total })}
          {needYou > 0 && <> · <span className="font-medium text-amber-700 dark:text-amber-400">{t("incidents.artifactsPanel.needYou", { count: needYou })}</span></>}
        </div>
      </div>
      <button type="button" onClick={onClose} aria-label={t("incidents.artifactsPanel.close")}
        className="flex size-8 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <X size={14} />
      </button>
    </div>
    <div role="group" aria-label={t("incidents.artifactsPanel.filters")} className="flex flex-wrap gap-1.5 border-b border-border px-4 py-3">
      <FilterChip active={filter === "all"} label={t("incidents.artifactsPanel.filterAll")} count={total} onSelect={() => { onFilterChange("all"); }} />
      <FilterChip active={filter === "sources"} label={t("incidents.integrationRail.sources")} count={sources.rows.length} onSelect={() => { onFilterChange("sources"); }} />
      <FilterChip active={filter === "runbooks"} label={t("incidents.artifactsPanel.filterRunbooks")} count={runbookSummary.count} onSelect={() => { onFilterChange("runbooks"); }} />
      <FilterChip active={filter === "actions"} label={t("incidents.integrationRail.ticketActions")} count={operationRows.length} onSelect={() => { onFilterChange("actions"); }} />
      {deliveries !== undefined && <FilterChip active={filter === "deliveries"} label={t("incidents.integrationRail.deliveries")} count={deliveryRows.rows.length} onSelect={() => { onFilterChange("deliveries"); }} />}
    </div>

    <div className={cn("min-h-0 flex-1 px-4 py-4", fillBody ? "flex flex-col overflow-hidden" : "space-y-5 overflow-y-auto")}>
      {showNeedsYou && <section aria-label={t("incidents.artifactsPanel.needsYouTitle")} className="space-y-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} aria-hidden="true" />
          {t("incidents.artifactsPanel.needsYouTitle")}
          <span className={AMBER_PILL}>{needYou}</span>
        </h3>
        {runbookSummary.pendingDrafts.map((draft) => <AttentionRow key={draft.proposalId} icon={FileText} title={draft.title} actionLabel={t("incidents.artifactsPanel.review")} onAction={() => { reviewDraft(draft.proposalId); }}
          subtitle={`${t(draft.kind === "create_new_runbook" ? "common.incidentArtifactsRail.proposal.newRunbook" : "common.incidentArtifactsRail.proposal.runbookUpdate")} · ${t("common.incidentArtifactsRail.proposal.versionOption", { version: draft.version })} · ${t("incidents.artifactsPanel.pendingApproval")}`} />)}
        {pendingOperations.map(operationCard)}
        {reviewDeliveries.map(deliveryCard)}
        {runbookSummary.failedRuns.map((run) => <AttentionRow key={run.key} icon={FileText} title={run.title} actionLabel={t("incidents.artifactsPanel.viewRun")} onAction={() => { viewRun(run.key); }}
          subtitle={t("common.incidentArtifactsRail.stepsComplete", { completed: run.completedSteps, total: run.totalSteps })}
          badge={<span className="rounded-full bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">{t("common.incidentArtifactsRail.status.failed")}</span>} />)}
      </section>}

      <Section label={t("incidents.integrationRail.sources")} visible={showSources}>
        <SectionHeading icon={Link2} label={t("incidents.integrationRail.sources")} count={sources.rows.length} />
        <IntegrationSourcesView threadId={threadId} rows={sources.rows} failed={sources.failed} disabled={disabled || sourceActions.busy} onSelect={sourceActions.select} onRefresh={sourceActions.refresh} actionError={sourceActions.error} showExecution={false} />
      </Section>

      <Section label={t("common.incidentArtifactsRail.runbookResults")} visible={showRunbooks} fill={fillBody} sectionRef={runbookSectionRef}>
        <div className="shrink-0"><SectionHeading icon={FileText} label={t("common.incidentArtifactsRail.runbookResults")} count={runbookSummary.count} /></div>
        <div className={cn("flex flex-col overflow-hidden rounded-2xl border border-border", fillBody ? "min-h-0 flex-1" : "h-[min(75vh,46rem)]")}>
          <RunbookResultsView results={runbookResults} onRevisionRequested={onRevisionRequested} />
        </div>
      </Section>

      <Section label={t("incidents.integrationRail.ticketActions")} visible={showActions}>
        <SectionHeading icon={Ticket} label={t("incidents.integrationRail.ticketActions")} count={operationRows.length} />
        <div className="space-y-2">
          {(actions.failed || decisions.failed) && <p role="alert" className={ERROR_BOX}>{t("incidents.integrationWrites.error")}</p>}
          {sectionOperations.map(operationCard)}
          {operationRows.length === 0 && !actions.failed && <div className={EMPTY_BOX}>{t("incidents.integrationRail.noActions")}</div>}
        </div>
      </Section>

      <Section label={t("incidents.integrationRail.deliveries")} visible={showDeliveries}>
        <SectionHeading icon={Webhook} label={t("incidents.integrationRail.deliveries")} count={deliveryRows.rows.length} />
        <div className="space-y-2">
          {deliveryRows.failed && <p role="alert" className={ERROR_BOX}>{t("incidents.deliveries.error")}</p>}
          {sectionDeliveries.map(deliveryCard)}
          {deliveryRows.rows.length === 0 && !deliveryRows.failed && <div className={EMPTY_BOX}>{t("incidents.integrationRail.noDeliveries")}</div>}
        </div>
      </Section>

      {everything && total === 0 && !sources.failed && !actions.failed && !deliveryRows.failed && <div className={EMPTY_BOX}>{t("incidents.artifactsPanel.empty")}</div>}
    </div>

    {execution.visible && <div className="shrink-0 border-t border-border">
      <button type="button" aria-expanded={footerOpen} aria-controls={footerId} onClick={() => { setFooterOpen((open) => !open); }}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <BookOpen size={14} aria-hidden="true" />
        <span className="flex-1">{t("incidents.artifactsPanel.runSavedRunbook")}</span>
        <ChevronDown size={14} aria-hidden="true" className={cn("text-muted-foreground transition-transform", footerOpen && "rotate-180")} />
      </button>
      {/* Closed, the review stays mounted: a run that is still going keeps being polled and its result stays reachable. */}
      <div id={footerId} hidden={!footerOpen} className="max-h-[50vh] overflow-y-auto px-4 pb-4">
        <KnowledgeExecutionPanel threadId={threadId} disabled={disabled || sourceActions.busy} active={execution.anySelected} hideTitle />
      </div>
    </div>}
  </aside>;
}
