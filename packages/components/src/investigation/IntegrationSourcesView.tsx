import { useEffect, useState, type ReactNode } from "react";
import { Check, ExternalLink, FileText, RefreshCw, Ticket } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/button.variants";
import { KnowledgeExecutionPanel } from "./KnowledgeExecutionPanel";
import { relativeTime } from "./relative-time";
export interface IntegrationResourcesPort { refresh?(resource: IntegrationResource): Promise<unknown>; select?(resource: IntegrationResource, selected: boolean): Promise<unknown>; list(threadId: string): Promise<IntegrationResource[]>; }

type BadgeVariant = "success" | "info" | "warning" | "secondary";
const SOLVED = new Set(["resolved", "closed"]);
const IN_PROGRESS = new Set(["assigned", "pending", "escalated_tto", "escalated_ttr", "waiting_for_approval"]);

/** A short scalar from the stored state; empty text and a zero id mean "not set" and are never shown. */
function fact(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text === "" || text === "0" ? "" : text;
}
function firstFact(state: IntegrationResource["state"], keys: string[]): string {
  for (const key of keys) {
    const value = fact(state[key]);
    if (value !== "") return value;
  }
  return "";
}
function ticketBadge(status: string): { variant: BadgeVariant; label: string } | null {
  if (status === "") return null;
  const key = status.toLowerCase();
  let variant: BadgeVariant = "secondary";
  if (SOLVED.has(key)) variant = "success";
  else if (key === "new") variant = "info";
  else if (IN_PROGRESS.has(key)) variant = "warning";
  return { variant, label: status.replaceAll("_", " ") };
}
const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);
const STALE_AFTER_MS = 300_000;
export const resourceKey = (row: IntegrationResource) => `${row.connectionId}:${row.resourceType}:${row.externalId}`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="truncate text-sm">{children}</dd></div>;
}

type Translate = ReturnType<typeof useTranslation>["t"];
interface CardView { referenceLine: string; badge: { variant: BadgeVariant; label: string } | null; facts: Array<[string, string]>; openLabel: string }

function ticketView(row: IntegrationResource, t: Translate): CardView {
  const className = fact(row.state.className);
  const reference = firstFact(row.state, ["ref", "reference"]);
  const identity = className === "" ? `#${row.externalId}` : `${className} #${row.externalId}`;
  return {
    referenceLine: reference === "" ? identity : `${reference} · ${identity}`,
    badge: ticketBadge(firstFact(row.state, ["status", "state", "lifecycle"])),
    facts: [
      [t("incidents.integrationResources.team"), firstFact(row.state, ["team_id", "team"])],
      [t("incidents.integrationResources.agent"), firstFact(row.state, ["agent_id", "agent"])],
      [t("incidents.integrationResources.requestType"), firstFact(row.state, ["request_type"])],
    ],
    openLabel: t("incidents.integrationResources.openInTicketSystem"),
  };
}
function documentView(row: IntegrationResource, t: Translate): CardView {
  const updated = fact(row.state.updatedAt);
  const published = fact(row.state.publishedAt) !== "";
  return {
    referenceLine: shortId(row.externalId),
    badge: published ? { variant: "success", label: t("incidents.integrationResources.published") } : { variant: "secondary", label: t("incidents.integrationResources.draft") },
    facts: [
      [t("incidents.integrationResources.updated"), updated === "" ? "" : new Date(updated).toLocaleDateString()],
      [t("incidents.integrationResources.collection"), shortId(fact(row.state.collectionId))],
    ],
    openLabel: t("incidents.integrationResources.openInKnowledgeBase"),
  };
}

function ResourceCard({ row, disabled, onToggle, onRefresh }: { row: IntegrationResource; disabled: boolean; onToggle?: (selected: boolean) => void; onRefresh?: () => void }) {
  const { t } = useTranslation();
  const selected = row.selected === true;
  const Icon = row.resourceType === "ticket" ? Ticket : FileText;
  const { referenceLine, badge, facts, openLabel } = row.resourceType === "ticket" ? ticketView(row, t) : documentView(row, t);
  const shownFacts = facts.filter(([, value]) => value !== "");
  const deleted = row.state.deleted === true;
  const stale = !deleted && Date.now() - Date.parse(row.observedAt) > STALE_AFTER_MS;
  return <article aria-label={row.title} className={cn("flex min-w-0 flex-col gap-2 rounded-2xl border border-border bg-card p-3 transition-colors hover:border-primary/40", selected && "bg-primary/5 ring-1 ring-primary")}>
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{row.connectionName}</span>
      {badge !== null && <Badge variant={badge.variant} className="ml-auto shrink-0 capitalize">{badge.label}</Badge>}
    </div>
    <div className="flex items-start gap-2">
      <h4 className="line-clamp-2 min-w-0 flex-1 text-sm font-medium">{row.title}</h4>
      <a href={row.url} target="_blank" rel="noopener noreferrer" aria-label={openLabel} title={openLabel} className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "size-7 shrink-0")}>
        <ExternalLink className="size-4" aria-hidden="true" />
      </a>
    </div>
    {/* A removed resource keeps its last known details below: nothing the engineer already read is lost. */}
    {deleted && <p role="status" className="rounded-md border border-amber-500/30 bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">{t("incidents.integrationRecovery.deleted")}</p>}
    {stale && <p className="text-xs text-amber-700 dark:text-amber-400">{t("incidents.integrationRecovery.staleCard")}</p>}
    <p className="truncate font-mono text-xs text-muted-foreground" title={row.externalId}>{referenceLine}</p>
    {shownFacts.length > 0 && <dl className="grid grid-cols-2 gap-x-3 gap-y-1">{shownFacts.map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>)}</dl>}
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2">
      <time className="min-w-0 truncate text-xs text-muted-foreground" dateTime={row.observedAt} title={new Date(row.observedAt).toLocaleString()}>{t("incidents.integrationResources.observedAt", { time: relativeTime(row.observedAt) })}</time>
      <div className="flex shrink-0 items-center gap-1.5">
      {onRefresh !== undefined && <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onRefresh} title={t("incidents.integrationRecovery.refresh")}>
        <RefreshCw aria-hidden="true" /><span className="sr-only">{t("incidents.integrationRecovery.refresh")}</span>
      </Button>}
      {onToggle !== undefined && <Button type="button" size="sm" variant={selected ? "default" : "outline"} aria-pressed={selected} disabled={disabled} onClick={() => { onToggle(!selected); }}>
        {selected && <Check aria-hidden="true" />}
        {t(selected ? "incidents.integrationResources.sourceSelected" : "incidents.integrationResources.useAsSource")}
      </Button>}
      </div>
    </div>
  </article>;
}

/**
 * Whether the saved-runbook review is shown for these sources. Once a source was selected the review stays mounted, so a
 * running execution is not lost when the last one is unchecked; `anySelected` only decides whether its controls are shown.
 */
export function useExecutionPanelState(rows: IntegrationResource[]) {
  const anySelected = rows.some((row) => row.selected === true);
  const [everSelected, setEverSelected] = useState(false);
  useEffect(() => { if (anySelected) setEverSelected(true); }, [anySelected]);
  return { anySelected, visible: anySelected || everSelected };
}

/**
 * The Sources view of the integrations rail: every linked ticket and document in one column, the source toggle on
 * each card, and the saved-runbook review below them once a source is selected.
 */
export function IntegrationSourcesView({ threadId, rows, failed, disabled, onSelect, onRefresh, actionError = null, showExecution = true }: {
  threadId: string;
  rows: IntegrationResource[];
  failed: boolean;
  disabled: boolean;
  /** Absent when the product cannot refresh a linked resource; the cards then show no refresh control. */
  onRefresh?: (resource: IntegrationResource) => void;
  /** The recovery message for the last select or refresh that failed. */
  actionError?: string | null;
  /** Absent when the product cannot select sources; the cards then show no toggle. */
  onSelect?: (resource: IntegrationResource, selected: boolean) => void;
  /** False where the host shows the saved-runbook review itself, outside this list. */
  showExecution?: boolean;
}) {
  const { t } = useTranslation();
  const execution = useExecutionPanelState(rows);
  return <div className="space-y-3">
    {actionError !== null && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t(actionError)}</p>}
    {failed && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t("incidents.integrationResources.error")}</p>}
    {rows.length === 0 && !failed && <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground">{t("incidents.integrationRail.noSources")}</div>}
    {rows.map((row) => <ResourceCard key={resourceKey(row)} row={row} disabled={disabled} onToggle={onSelect === undefined ? undefined : (selected) => { onSelect(row, selected); }} onRefresh={onRefresh === undefined ? undefined : () => { onRefresh(row); }} />)}
    {showExecution && execution.visible && <KnowledgeExecutionPanel threadId={threadId} disabled={disabled} active={execution.anySelected} />}
  </div>;
}
