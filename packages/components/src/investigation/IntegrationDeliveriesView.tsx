import { useMemo, useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useTranslation } from "@bitsentry-ce/i18n";
import { relativeTime } from "./relative-time";

export interface IntegrationDelivery { id: string; eventId: string; channel: string; state: string; externalId: string | null; updatedAt: string; }
export interface IntegrationDeliveriesPort {
  list(threadId: string): Promise<IntegrationDelivery[]>;
  retry(threadId: string, id: string): Promise<unknown>;
  reconcile(threadId: string, id: string, externalId: string, confirmed: boolean): Promise<unknown>;
}

const CHANGES_CHANNEL = "itop:changes";
const CREATE_CHANNEL = "itop:create";
const MAX_REASON_LENGTH = 300;
type StatusVariant = "warning" | "info" | "success" | "destructive" | "secondary";
const STATE_VARIANTS: Record<string, StatusVariant> = { processing: "info", succeeded: "success", failed: "destructive", uncertain: "warning", reconciled: "secondary" };

/** Whether the engineer has something to do: a failed state synchronization or a creation whose outcome is unknown. */
export const needsReview = (row: IntegrationDelivery) => (row.channel === CHANGES_CHANNEL && row.state === "failed") || (row.channel === CREATE_CHANNEL && row.state === "uncertain");
/** Deliveries that need review come first; the newest come first within each group. */
export function orderDeliveries(rows: IntegrationDelivery[]): IntegrationDelivery[] {
  return [...rows].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || b.updatedAt.localeCompare(a.updatedAt));
}
const shortEvent = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

function RecoveryControls({ row, threadId, disabled, service, onRefresh }: {
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

function DeliveryCard({ row, threadId, disabled, service, onRefresh }: {
  row: IntegrationDelivery; threadId: string; disabled: boolean; service: IntegrationDeliveriesPort; onRefresh(): Promise<void>;
}) {
  const { t } = useTranslation();
  const channel = row.channel === CREATE_CHANNEL ? t("incidents.deliveries.channel.create") : t("incidents.deliveries.channel.changes");
  return <article aria-label={`${channel} ${shortEvent(row.eventId)}`} className="min-w-0 space-y-2 rounded-2xl border border-border bg-card p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{channel}</span>
      <Badge variant={STATE_VARIANTS[row.state] ?? "secondary"} className="shrink-0">{t(`incidents.deliveries.${row.state}`)}</Badge>
    </div>
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <time dateTime={row.updatedAt} title={new Date(row.updatedAt).toLocaleString()}>{relativeTime(row.updatedAt)}</time>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate font-mono" title={row.eventId}>{shortEvent(row.eventId)}</span>
    </p>
    {/* The form is keyed by what it was built for, so a new status or a new ticket ID starts it from a clean state. */}
    {needsReview(row) && <RecoveryControls key={`${row.state}:${row.externalId ?? ""}`} row={row} threadId={threadId} disabled={disabled} service={service} onRefresh={onRefresh} />}
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
