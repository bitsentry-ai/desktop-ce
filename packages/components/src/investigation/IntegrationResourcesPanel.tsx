import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, ExternalLink, FileText, Ticket } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { useBitsentryServices } from "../services/context";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { buttonVariants } from "../ui/button.variants";
import { KnowledgeExecutionPanel } from "./KnowledgeExecutionPanel";
export interface IntegrationResourcesPort { select?(resource: IntegrationResource, selected: boolean): Promise<unknown>; list(threadId: string): Promise<IntegrationResource[]>; }
export function DesktopIntegrationResourcesPanel({ threadId, disabled = false }: { threadId: string; disabled?: boolean }) {
  const { plugins } = useBitsentryServices();
  const service = useMemo(() => plugins?.listResources ? { list: plugins.listResources.bind(plugins), select: plugins.selectResource?.bind(plugins) } : null, [plugins]);
  return service ? <IntegrationResourcesPanel threadId={threadId} service={service} disabled={disabled} /> : null;
}

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
function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const steps: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), "minute");
}
const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);

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

function ResourceCard({ row, disabled, onToggle }: { row: IntegrationResource; disabled: boolean; onToggle?: (selected: boolean) => void }) {
  const { t } = useTranslation();
  const selected = row.selected === true;
  const Icon = row.resourceType === "ticket" ? Ticket : FileText;
  const { referenceLine, badge, facts, openLabel } = row.resourceType === "ticket" ? ticketView(row, t) : documentView(row, t);
  const shownFacts = facts.filter(([, value]) => value !== "");
  return <article aria-label={row.title} className={cn("flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40", selected && "bg-primary/5 ring-1 ring-primary")}>
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
    <p className="truncate font-mono text-xs text-muted-foreground" title={row.externalId}>{referenceLine}</p>
    {shownFacts.length > 0 && <dl className="grid grid-cols-2 gap-x-3 gap-y-1">{shownFacts.map(([label, value]) => <Fact key={label} label={label}>{value}</Fact>)}</dl>}
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2">
      <time className="min-w-0 truncate text-xs text-muted-foreground" dateTime={row.observedAt} title={new Date(row.observedAt).toLocaleString()}>{t("incidents.integrationResources.observedAt", { time: relativeTime(row.observedAt) })}</time>
      {onToggle !== undefined && <Button type="button" size="sm" variant={selected ? "default" : "outline"} aria-pressed={selected} disabled={disabled} onClick={() => { onToggle(!selected); }}>
        {selected && <Check aria-hidden="true" />}
        {t(selected ? "incidents.integrationResources.sourceSelected" : "incidents.integrationResources.useAsSource")}
      </Button>}
    </div>
  </article>;
}

export function IntegrationResourcesPanel({ threadId, service, disabled = false }: { threadId: string; service: IntegrationResourcesPort; disabled?: boolean }) {
  const { t } = useTranslation();
  const bodyId = useId();
  const [rows, setRows] = useState<IntegrationResource[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // Once a source was selected the execution panel stays mounted, so a running execution is not lost when the last one is unchecked.
  const [everSelected, setEverSelected] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const result = await service.list(threadId); if (active) { setRows(result); setFailed(false); } } catch { if (active) setFailed(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [threadId, service]);
  const selectedCount = rows.filter((row) => row.selected === true).length;
  const anySelected = selectedCount > 0;
  useEffect(() => { if (anySelected) setEverSelected(true); }, [anySelected]);
  if (!rows.length && !failed) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <section aria-label={t("incidents.integrationResources.title")} className="shrink-0 border-b border-border px-4 py-2">
    <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => { setOpen((value) => !value); }} className="flex w-full items-center gap-2 rounded-md py-1 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Chevron className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="font-medium">{t("incidents.integrationResources.title")}</span>
      <Badge variant="secondary">{rows.length}</Badge>
      {anySelected && <span className="text-xs text-muted-foreground">{t("incidents.integrationResources.selectedCount", { selected: selectedCount })}</span>}
    </button>
    {failed && <p role="alert" className="py-1 text-sm text-destructive">{t("incidents.integrationResources.error")}</p>}
    <div id={bodyId} hidden={!open} className="-mx-1 max-h-[50vh] overflow-y-auto px-1">
      <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => <ResourceCard key={`${row.connectionId}:${row.resourceType}:${row.externalId}`} row={row} disabled={disabled}
          onToggle={service.select === undefined ? undefined : (selected) => { void service.select!(row, selected).then(() => service.list(threadId)).then(setRows).catch(() => { setFailed(true); }); }} />)}
      </div>
      {(anySelected || everSelected) && <KnowledgeExecutionPanel threadId={threadId} disabled={disabled} active={anySelected} />}
    </div>
  </section>;
}
