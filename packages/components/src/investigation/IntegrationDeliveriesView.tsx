import { useActionPermissions } from "../services/context";
import { useId, useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useTranslation } from "@bitsentry-ce/i18n";
import { relativeTime } from "./relative-time";

/** Why the triage policy let a ticket creation through or held it. */
export interface DeliveryDecision {
  outcome: "accept" | "hold";
  reasons: string[];
  policyVersion: string;
  source: string | null;
  repeatCount: number;
  previousEventId: string | null;
  windowMinutes: number;
}
/** An engineer's decision on a held ticket creation. */
export interface DeliveryOverride { action: "authorized" | "dismissed"; reason: string; at: string; }
export interface IntegrationDelivery {
  id: string; eventId: string; channel: string; state: string; externalId: string | null; updatedAt: string;
  title?: string | null; priority?: string | null; decision?: DeliveryDecision | null; override?: DeliveryOverride | null;
}
export interface IntegrationDeliveriesPort {
  list(threadId: string): Promise<IntegrationDelivery[]>;
  retry(threadId: string, id: string): Promise<unknown>;
  reconcile(threadId: string, id: string, externalId: string, confirmed: boolean): Promise<unknown>;
  /** Hosts that gate external ticket creation let the engineer create or dismiss a held event, always with a reason. */
  authorize?(threadId: string, id: string, reason: string): Promise<unknown>;
  dismiss?(threadId: string, id: string, reason: string): Promise<unknown>;
}

const CHANGES_CHANNEL = "itop:changes";
const CREATE_CHANNEL = "itop:create";
const MAX_REASON_LENGTH = 300;
type StatusVariant = "warning" | "info" | "success" | "destructive" | "secondary";
const STATE_VARIANTS: Record<string, StatusVariant> = { processing: "info", succeeded: "success", failed: "destructive", uncertain: "warning", reconciled: "secondary", held: "warning", dismissed: "secondary" };
/** An engineer's reason is saved in the audit log; the server refuses a shorter one. */
export const MIN_OVERRIDE_REASON = 10;
const MAX_OVERRIDE_REASON = 500;

/** Whether the engineer has something to do: a failed state synchronization, or a creation that is held or whose outcome is unknown. */
export const needsReview = (row: IntegrationDelivery) => (row.channel === CHANGES_CHANNEL && row.state === "failed") || (row.channel === CREATE_CHANNEL && (row.state === "uncertain" || row.state === "held"));
/** Deliveries that need review come first; the newest come first within each group. */
export function orderDeliveries(rows: IntegrationDelivery[]): IntegrationDelivery[] {
  return [...rows].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || b.updatedAt.localeCompare(a.updatedAt));
}
export const shortEvent = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

export function DeliveryRecoveryControls({ row, threadId, disabled, service, onRefresh }: {
  row: IntegrationDelivery; threadId: string; disabled: boolean; service: IntegrationDeliveriesPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [typedId, setTypedId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Once the provider has returned a ticket ID that is the only ID that can be reconciled; an earlier typed value never outlives it.
  const externalId = row.externalId ?? typedId.trim();
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await onRefresh();
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message.trim().slice(0, MAX_REASON_LENGTH) : "";
      setFailure(reason || t("incidents.deliveries.error"));
    } finally {
      setBusy(false);
    }
  }
  return <div className="space-y-2 border-t border-border pt-3">
    {failure !== null && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{failure}</p>}
    {row.channel === CHANGES_CHANNEL && row.state === "failed" &&
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { void perform(() => service.retry(threadId, row.id)); }}>{t("incidents.deliveries.retry")}</Button>}
    {row.channel === CREATE_CHANNEL && row.state === "held" && <HeldReview row={row} threadId={threadId} disabled={disabled || busy} service={service} perform={perform} />}
    {row.channel === CREATE_CHANNEL && row.state === "uncertain" && <>
      <p className="text-sm text-muted-foreground">{t("incidents.deliveries.inspect")}</p>
      {row.externalId === null
        ? <input className="w-full rounded border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("incidents.integrationWrites.externalId")}
          placeholder={t("incidents.integrationWrites.externalId")} value={typedId} disabled={disabled || busy} onChange={(event) => { setTypedId(event.target.value); }} />
        : <p className="text-sm">{t("incidents.deliveries.providerId", { id: row.externalId })}</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-primary" checked={confirmed} disabled={disabled || busy} onChange={(event) => { setConfirmed(event.target.checked); }} /> {t("incidents.integrationWrites.inspected")}</label>
      <Button size="sm" disabled={disabled || busy || !confirmed || externalId === ""} onClick={() => { void perform(() => service.reconcile(threadId, row.id, externalId, confirmed)); }}>{t("incidents.deliveries.reconcile")}</Button>
    </>}
  </div>;
}

function HeldReview({ row, threadId, disabled, service, perform }: {
  row: IntegrationDelivery; threadId: string; disabled: boolean; service: IntegrationDeliveriesPort; perform(action: () => Promise<unknown>): Promise<void>;
}) {
  const { t } = useTranslation();
  const { canOperate, operatorTitle } = useActionPermissions();
  const id = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const { authorize, dismiss } = service;
  if (authorize === undefined || dismiss === undefined) return <p className="text-sm text-muted-foreground">{t("incidents.deliveries.heldHint")}</p>;
  const trimmed = reason.trim();
  const tooShort = trimmed.length < MIN_OVERRIDE_REASON;
  const error = touched && tooShort ? t("incidents.deliveries.reasonTooShort", { min: MIN_OVERRIDE_REASON }) : undefined;
  return <>
    <p className="text-sm text-muted-foreground">{t("incidents.deliveries.heldHint")}</p>
    <div className="space-y-1.5">
      <label htmlFor={`${id}-reason`} className="block text-xs font-medium text-muted-foreground">{t("incidents.deliveries.reasonLabel")}</label>
      <Textarea id={`${id}-reason`} className="min-h-[64px] text-sm" value={reason} maxLength={MAX_OVERRIDE_REASON} disabled={disabled}
        placeholder={t("incidents.deliveries.reasonPlaceholder")} aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-reason-error`}
        onBlur={() => { setTouched(true); }} onChange={(event) => { setReason(event.target.value); }} />
      {error !== undefined && <p id={`${id}-reason-error`} className="text-xs text-destructive">{error}</p>}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" title={operatorTitle} disabled={!canOperate || disabled || tooShort} onClick={() => { void perform(() => authorize(threadId, row.id, trimmed)); }}>{t("incidents.deliveries.authorize")}</Button>
      <Button size="sm" variant="outline" title={operatorTitle} disabled={!canOperate || disabled || tooShort} onClick={() => { void perform(() => dismiss(threadId, row.id, trimmed)); }}>{t("incidents.deliveries.dismiss")}</Button>
    </div>
  </>;
}

/** What the triage policy decided for a ticket creation and why, and what an engineer decided afterwards. */
export function DeliveryDecisionDetails({ row }: { row: IntegrationDelivery }) {
  const { t } = useTranslation();
  const { decision, override } = row;
  if (row.channel !== CREATE_CHANNEL || (decision == null && (row.title ?? null) === null)) return null;
  const reasonText = (reason: string) => t(`incidents.deliveries.reason.${reason}`, {
    priority: row.priority ?? "", source: decision?.source ?? "", eventId: shortEvent(decision?.previousEventId ?? ""),
    minutes: decision?.windowMinutes ?? 0, earlier: decision?.repeatCount ?? 0,
  });
  return <div className="space-y-1.5 text-sm">
    {(row.title ?? null) !== null && <p className="break-words font-medium">{row.title}</p>}
    {decision != null && <>
      <p className="text-xs text-muted-foreground">
        {t(decision.outcome === "accept" ? "incidents.deliveries.decision.accepted" : "incidents.deliveries.decision.held")}
        {(row.priority ?? null) !== null && <> · {row.priority}</>}
        {decision.source !== null && <> · {t("incidents.deliveries.source", { source: decision.source })}</>}
      </p>
      {decision.reasons.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs">{decision.reasons.map((reason) => <li key={reason}>{reasonText(reason)}</li>)}</ul>}
    </>}
    {override != null && <p className="break-words text-xs text-muted-foreground">
      {t(override.action === "authorized" ? "incidents.deliveries.override.authorized" : "incidents.deliveries.override.dismissed", { reason: override.reason })}
    </p>}
  </div>;
}

export const deliveryChannelLabel = (row: IntegrationDelivery, t: ReturnType<typeof useTranslation>["t"]) =>
  (row.channel === CREATE_CHANNEL ? t("incidents.deliveries.channel.create") : t("incidents.deliveries.channel.changes"));
export function DeliveryStateBadge({ row }: { row: IntegrationDelivery }) {
  const { t } = useTranslation();
  return <Badge variant={STATE_VARIANTS[row.state] ?? "secondary"} className="shrink-0">{t(`incidents.deliveries.${row.state}`)}</Badge>;
}

function DeliveryCard({ row, threadId, disabled, service, onRefresh }: {
  row: IntegrationDelivery; threadId: string; disabled: boolean; service: IntegrationDeliveriesPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const channel = deliveryChannelLabel(row, t);
  return <article aria-label={`${channel} ${shortEvent(row.eventId)}`} className="min-w-0 space-y-2 rounded-2xl border border-border bg-card p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{channel}</span>
      <DeliveryStateBadge row={row} />
    </div>
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString()}>{relativeTime(row.updatedAt)}</time>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono" title={row.eventId}>{shortEvent(row.eventId)}</span>
    </p>
    <DeliveryDecisionDetails row={row} />
    {/* The form is keyed by what it was built for, so a new status or a new ticket ID starts it from a clean state. */}
    {needsReview(row) && <DeliveryRecoveryControls key={`${row.state}:${row.externalId ?? ""}`} row={row} threadId={threadId} disabled={disabled} service={service} onRefresh={onRefresh} />}
  </article>;
}

/**
 * The Deliveries view of the integrations rail: what arrived from iTop and what was sent to it, with recovery for the
 * ones that failed or whose outcome is unknown. Everything shown and every control follows the latest list.
 */
export function IntegrationDeliveriesView({ threadId, rows, failed, disabled, service, onRefresh }: {
  threadId: string; rows: IntegrationDelivery[]; failed: boolean; disabled: boolean; service: IntegrationDeliveriesPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const ordered = useMemo(() => orderDeliveries(rows), [rows]);
  return <div className="space-y-3">
    {failed && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t("incidents.deliveries.error")}</p>}
    {ordered.length === 0 && !failed && <div className="rounded-2xl border border-dashed border-border/70 bg-muted/10 px-4 py-5 text-sm text-muted-foreground">{t("incidents.integrationRail.noDeliveries")}</div>}
    {ordered.map((row) => <DeliveryCard key={row.id} row={row} threadId={threadId} disabled={disabled} service={service} onRefresh={onRefresh} />)}
  </div>;
}
