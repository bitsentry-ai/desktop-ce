import { useEffect, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { Button } from "../ui/button";
export interface IntegrationDelivery { id: string; eventId: string; channel: string; state: string; externalId: string | null; updatedAt: string; }
export interface IntegrationDeliveriesPort {
  list(threadId: string): Promise<IntegrationDelivery[]>;
  retry(threadId: string, id: string): Promise<unknown>;
  reconcile(threadId: string, id: string, externalId: string, confirmed: boolean): Promise<unknown>;
}
export function IntegrationDeliveriesPanel({ threadId, service, disabled }: { threadId: string; service: IntegrationDeliveriesPort; disabled: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationDelivery[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const next = await service.list(threadId); if (active) { setRows(next); setError(false); } } catch { if (active) setError(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [threadId, service]);
  if (!rows.length && !error) return null;
  return <details className="max-h-64 shrink-0 overflow-auto border-b border-border px-4 py-2">
    <summary>{t("incidents.deliveries.title")} ({rows.length})</summary>
    {error && <p role="alert">{t("incidents.deliveries.error")}</p>}
    {rows.map((row) => <Delivery key={row.id} row={row} disabled={disabled} service={service} threadId={threadId} onRefresh={async () => setRows(await service.list(threadId))} />)}
  </details>;
}
function Delivery({ row, disabled, service, threadId, onRefresh }: { row: IntegrationDelivery; disabled: boolean; service: IntegrationDeliveriesPort; threadId: string; onRefresh(): Promise<void> }) {
  const { t } = useTranslation();
  const [externalId, setExternalId] = useState(row.externalId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function perform(action: () => Promise<unknown>) { setBusy(true); setError(false); try { await action(); await onRefresh(); } catch { setError(true); } finally { setBusy(false); } }
  return <article className="space-y-2 rounded border border-border p-2 text-sm">
    <p>{row.eventId} · {row.channel} · {t(`incidents.deliveries.${row.state}`)}</p>
    <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>
    {error && <p role="alert">{t("incidents.deliveries.error")}</p>}
    {row.channel === "itop:changes" && row.state === "failed" && <Button disabled={disabled || busy} onClick={() => { void perform(() => service.retry(threadId, row.id)); }}>{t("incidents.deliveries.retry")}</Button>}
    {row.channel === "itop:create" && row.state === "uncertain" && <>
      <p>{t("incidents.deliveries.inspect")}</p>
      <input className="rounded border border-border bg-background p-1" aria-label={t("incidents.integrationWrites.externalId")} value={externalId} disabled={disabled || busy || row.externalId !== null} onChange={(event) => setExternalId(event.target.value)} />
      <label><input type="checkbox" checked={confirmed} disabled={disabled || busy} onChange={(event) => setConfirmed(event.target.checked)} /> {t("incidents.integrationWrites.inspected")}</label>
      <Button disabled={disabled || busy || !confirmed || !externalId.trim()} onClick={() => { void perform(() => service.reconcile(threadId, row.id, externalId.trim(), confirmed)); }}>{t("incidents.deliveries.reconcile")}</Button>
    </>}
  </article>;
}
