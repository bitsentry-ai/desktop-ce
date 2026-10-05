import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileText, Ticket } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation } from "@bitsentry-ce/core/features/plugins";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { relativeTime } from "./relative-time";
export interface IntegrationOperationsPort {
  renew?(threadId: string, id: string): Promise<unknown>;
  reconcile?(threadId: string, id: string, applied: boolean, confirmed: boolean, externalId?: string): Promise<unknown>;
  list(threadId: string): Promise<IntegrationOperation[]>;
  approve(threadId: string, id: string, closeRequested: boolean): Promise<unknown>;
  cancel(threadId: string, id: string): Promise<unknown>;
}
type StatusVariant = "warning" | "info" | "success" | "destructive" | "secondary";
const STATUS_VARIANTS: Record<IntegrationOperation["status"], StatusVariant> = {
  proposed: "warning", executing: "info", succeeded: "success", failed: "destructive", uncertain: "warning", cancelled: "secondary", reconciled: "secondary",
};
const MAX_REFUSAL_LENGTH = 300;
/** What the remote system refused for, set when a write definitely did not apply. An unknown outcome never gets one. */
const REFUSAL_KEYS: Record<string, string> = { credentials_rejected: "incidents.integrationRecovery.credentials", stale_resource: "incidents.integrationRecovery.stale", remote_rejected: "incidents.integrationRecovery.rejected" };
const ITOP_FACT_KEYS = ["class", "id", "stimulus"] as const;
const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
type Translate = ReturnType<typeof useTranslation>["t"];

interface Change { key: string; value: string }
/** Readable view of what the request changes; the raw input stays available under technical details. */
export function summarizeOperation(row: IntegrationOperation) {
  const listedFields = typeof row.input.fields === "object" && row.input.fields !== null && !Array.isArray(row.input.fields);
  const fields = listedFields ? row.input.fields as Record<string, unknown> : {};
  // `class`, `id` and `stimulus` only mean a ticket, ticket ID and transition for iTop; other plugins list them like any input.
  const factKeys: readonly string[] = row.pluginId === "itop" ? ITOP_FACT_KEYS : [];
  const hiddenKeys = new Set(["outputFields", ...(listedFields ? ["fields"] : []), ...factKeys]);
  const changes: Change[] = [
    ...Object.entries(fields).map(([key, value]) => ({ key, value: display(value) })),
    ...Object.entries(row.input).filter(([key]) => !hiddenKeys.has(key)).map(([key, value]) => ({ key, value: display(value) })),
  ];
  const facts = factKeys.filter((key) => row.input[key] !== undefined).map((key) => ({ key, value: display(row.input[key]) }));
  return { changes, facts };
}
/** Newest first, so the request that just arrived is at the top of the list. */
export const orderOperations = (rows: IntegrationOperation[]) => [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
/** What deserves attention first: a request awaiting approval, then an uncertain outcome, then the newest. */
export function preferredOperation(rows: IntegrationOperation[]): IntegrationOperation | null {
  return rows.find((row) => row.status === "proposed") ?? rows.find((row) => row.status === "uncertain") ?? rows[0] ?? null;
}
export const operationLabel = (row: IntegrationOperation, t: Translate) => row.ticketOperation === undefined ? row.actionId : t(`incidents.integrationWrites.operation.${row.ticketOperation}`);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all text-sm">{children}</dd></div>;
}
export function StatusBadges({ row }: { row: IntegrationOperation }) {
  const { t } = useTranslation();
  return <>
    <Badge variant={STATUS_VARIANTS[row.status]} className="shrink-0">{t(`incidents.integrationWrites.${row.status}`)}</Badge>
    {row.publicUpdate && <Badge variant="warning" className="shrink-0">{t("incidents.integrationRail.publicBadge")}</Badge>}
  </>;
}

function OperationListItem({ row, isSelected, onSelect }: { row: IntegrationOperation; isSelected: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const Icon = row.ticketOperation === undefined ? FileText : Ticket;
  return <button type="button" aria-pressed={isSelected} onClick={onSelect}
    className={cn("w-full rounded-2xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", isSelected ? "border-primary bg-primary/5" : "border-border bg-muted/10 hover:bg-muted/20")}>
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background"><Icon size={15} className="text-muted-foreground" aria-hidden="true" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{operationLabel(row, t)}</span>
          <StatusBadges row={row} />
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {row.connectionName} · <time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString()}>{relativeTime(row.updatedAt)}</time>
        </div>
      </div>
    </div>
  </button>;
}

interface OperationBodyProps {
  row: IntegrationOperation; disabled: boolean; busy: boolean; refusal: string | undefined; closeRequested: boolean;
  onCloseRequestedChange(value: boolean): void; onApprove(): void; onReject(): void; service: IntegrationOperationsPort; onRefresh(): Promise<void>;
}
const RAIL_BODY_CLASS = "min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden px-4 py-4";

/** The exact proposal with its approval and recovery controls. `className` frames it: the rail scrolls it, a card in the Artifacts panel does not. */
export function OperationBody({ row, disabled, busy, refusal, closeRequested, onCloseRequestedChange, onApprove, onReject, service, onRefresh, className = RAIL_BODY_CLASS }: OperationBodyProps & { className?: string }) {
  const { t } = useTranslation();
  const { changes, facts } = summarizeOperation(row);
  const awaiting = row.status === "proposed";
  return <div className={className}>
    {row.publicUpdate && <p role="note" className="rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">{t("incidents.integrationWrites.public")}</p>}
    <dl className="grid grid-cols-1 gap-3">
      <Fact label={t("incidents.integrationWrites.target")}>{row.target}</Fact>
      <Fact label={t("incidents.integrationWrites.action")}><code className="text-xs">{row.actionId}</code></Fact>
      {facts.map((fact) => <Fact key={fact.key} label={t(`incidents.integrationWrites.fact.${fact.key}`)}>{fact.value}</Fact>)}
    </dl>
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("incidents.integrationWrites.changes")}</h4>
      {changes.length === 0
        ? <p className="text-sm text-muted-foreground">{t("incidents.integrationWrites.noChanges")}</p>
        : <ul className="divide-y divide-border rounded-md border border-border">
          {changes.map((change) => <li key={change.key} className="px-3 py-2 text-sm">
            <code className="block break-all text-xs text-muted-foreground">{change.key}</code>
            <span className="mt-0.5 block whitespace-pre-wrap break-words">{change.value}</span>
          </li>)}
        </ul>}
    </div>
    {row.status === "failed" && row.message !== undefined && REFUSAL_KEYS[row.message] !== undefined && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t(REFUSAL_KEYS[row.message]!)}</p>}
    {(row.status === "uncertain" || row.status === "executing") && <p className="text-sm text-muted-foreground">{row.message ?? t("incidents.integrationWrites.inspect")}</p>}
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">{t("incidents.integrationWrites.details")}</summary>
      <p className="mt-2 font-medium">{t("incidents.integrationWrites.request")}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(row.input, null, 2)}</pre>
      {row.result !== undefined && <>
        <p className="mt-2 font-medium">{t("incidents.integrationWrites.result")}</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(row.result, null, 2)}</pre>
      </>}
    </details>
    {awaiting && refusal !== undefined && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{refusal}</p>}
    {awaiting && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {row.requiresCloseRequest && <label className="mr-auto flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={closeRequested} disabled={disabled || busy} onChange={(event) => { onCloseRequestedChange(event.target.checked); }} /> {t("incidents.integrationWrites.closeRequest")}</label>}
      <Button size="sm" disabled={disabled || busy || (row.requiresCloseRequest && !closeRequested)} onClick={onApprove}>{t("incidents.integrationWrites.approve")}</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={onReject}>{t("incidents.integrationWrites.cancel")}</Button>
    </div>}
    <OperationRecoveryControls row={row} service={service} disabled={disabled || busy} onRefresh={onRefresh} />
  </div>;
}

function OperationDetails(props: OperationBodyProps) {
  const { t } = useTranslation();
  const { row } = props;
  return <section aria-label={operationLabel(row, t)} className="flex h-full min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card">
    <div className="border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{operationLabel(row, t)}</h3>
        <StatusBadges row={row} />
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">{row.connectionName}</p>
    </div>
    <OperationBody {...props} />
  </section>;
}

export interface OperationDecisions {
  busy: boolean;
  /** An approval or rejection failed without a reason the engineer can act on. */
  failed: boolean;
  closeRequested(id: string): boolean;
  setCloseRequested(id: string, value: boolean): void;
  /** What the remote system refused for. It stays with its operation across list refreshes. */
  refusal(id: string): string | undefined;
  decide(row: IntegrationOperation, approve: boolean): Promise<void>;
}

/** Approve and reject for the operations of one incident, shared by every list that shows them. A client without ticket actions has nothing to decide. */
export function useOperationDecisions({ threadId, service, onRefresh }: {
  threadId: string; service: IntegrationOperationsPort | undefined; onRefresh(): Promise<void>;
}): OperationDecisions {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [closeRequests, setCloseRequests] = useState<Record<string, boolean>>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  async function decide(row: IntegrationOperation, approve: boolean) {
    if (service === undefined) return;
    setBusy(true); setFailed(false);
    setRefusals((old) => Object.fromEntries(Object.entries(old).filter(([id]) => id !== row.id)));
    try {
      if (approve) await service.approve(threadId, row.id, closeRequests[row.id] === true);
      else await service.cancel(threadId, row.id);
      await onRefresh();
    } catch (caught) {
      // A refusal explains why nothing was written. It belongs to its operation and must outlive the list refresh.
      const reason = caught instanceof Error ? caught.message.trim().slice(0, MAX_REFUSAL_LENGTH) : "";
      if (reason === "") setFailed(true);
      else setRefusals((old) => ({ ...old, [row.id]: reason }));
    } finally { setBusy(false); }
  }
  return {
    busy, failed, decide,
    closeRequested: (id) => closeRequests[id] === true,
    setCloseRequested: (id, value) => { setCloseRequests((old) => ({ ...old, [id]: value })); },
    refusal: (id) => refusals[id],
  };
}

/**
 * The Ticket actions view of the integrations rail: one summary per operation, and the full proposal of the selected
 * one with its approval and recovery controls. A request that just arrived is selected; otherwise the selection is kept.
 */
export function IntegrationActionsView({ threadId, rows, failed, disabled, service, onRefresh }: {
  threadId: string; rows: IntegrationOperation[]; failed: boolean; disabled: boolean; service: IntegrationOperationsPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const ordered = useMemo(() => orderOperations(rows), [rows]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const decisions = useOperationDecisions({ threadId, service, onRefresh });
  const knownIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const known = knownIdsRef.current;
    const arrived = ordered.filter((row) => !known.has(row.id));
    arrived.forEach((row) => known.add(row.id));
    const awaiting = arrived.find((row) => row.status === "proposed");
    if (awaiting !== undefined) { setSelectedId(awaiting.id); return; }
    if (ordered.some((row) => row.id === selectedId)) return;
    setSelectedId(preferredOperation(ordered)?.id ?? null);
  }, [ordered, selectedId]);
  const selected = ordered.find((row) => row.id === selectedId) ?? null;
  return <div className="flex min-h-0 flex-1 flex-col">
    {(failed || decisions.failed) && <p role="alert" className="mx-4 mt-4 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t("incidents.integrationWrites.error")}</p>}
    <div className="max-h-[min(40vh,18rem)] shrink-0 overflow-y-auto px-4 py-4">
      <div className="space-y-2">
        {ordered.map((row) => <OperationListItem key={row.id} row={row} isSelected={row.id === selectedId} onSelect={() => { setSelectedId(row.id); }} />)}
        {ordered.length === 0 && !failed && <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground">{t("incidents.integrationRail.noActions")}</div>}
      </div>
    </div>
    <div className="min-h-0 flex-1 px-4 pb-4">
      {selected !== null && <OperationDetails key={selected.id} row={selected} disabled={disabled} busy={decisions.busy} refusal={decisions.refusal(selected.id)} closeRequested={decisions.closeRequested(selected.id)}
        onCloseRequestedChange={(value) => { decisions.setCloseRequested(selected.id, value); }}
        onApprove={() => { void decisions.decide(selected, true); }} onReject={() => { void decisions.decide(selected, false); }} service={service} onRefresh={onRefresh} />}
      {selected === null && ordered.length > 0 && <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 text-center text-sm text-muted-foreground">{t("incidents.integrationRail.selectAction")}</div>}
    </div>
  </div>;
}

function OperationRecoveryControls({ row, service, disabled, onRefresh }: { row: IntegrationOperation; service: IntegrationOperationsPort; disabled: boolean; onRefresh(): Promise<void> }) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);
  const [externalId, setExternalId] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await onRefresh();
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message.trim().slice(0, MAX_REFUSAL_LENGTH) : "";
      setFailure(reason || t("incidents.integrationWrites.error"));
    } finally {
      setBusy(false);
    }
  }
  const terminal = ["succeeded", "reconciled", "failed", "cancelled"].includes(row.status);
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    {failure !== null && <p role="alert" className="w-full rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{failure}</p>}
    {row.status === "uncertain" && service.reconcile && <>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={confirmed} disabled={disabled || busy} onChange={(event) => setConfirmed(event.target.checked)} /> {t("incidents.integrationWrites.inspected")}</label>
      <input className="w-full rounded border border-border bg-background px-2 py-1 text-sm" aria-label={t("incidents.integrationWrites.externalId")} placeholder={t("incidents.integrationWrites.externalId")} value={externalId} onChange={(event) => setExternalId(event.target.value)} disabled={disabled || busy} />
      <Button size="sm" disabled={disabled || busy || !confirmed || !externalId.trim()} onClick={() => { void perform(() => service.reconcile!(row.threadId, row.id, true, confirmed, externalId.trim())); }}>{t("incidents.integrationWrites.confirmApplied")}</Button>
      <Button size="sm" variant="outline" disabled={disabled || busy || !confirmed} onClick={() => { void perform(() => service.reconcile!(row.threadId, row.id, false, confirmed)); }}>{t("incidents.integrationWrites.confirmNotApplied")}</Button>
    </>}
    {terminal && service.renew && <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { void perform(() => service.renew!(row.threadId, row.id)); }}>{t("incidents.integrationWrites.renew")}</Button>}
  </div>;
}
