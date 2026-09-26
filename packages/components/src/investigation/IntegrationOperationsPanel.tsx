import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation } from "@bitsentry-ce/core/features/plugins";
import { Button } from "../ui/button";
import { useBitsentryServices } from "../services/context";
export interface IntegrationOperationsPort {
  list(threadId: string): Promise<IntegrationOperation[]>;
  approve(threadId: string, id: string, closeRequested: boolean): Promise<unknown>;
  cancel(threadId: string, id: string): Promise<unknown>;
}
export function DesktopIntegrationOperationsPanel({ threadId, disabled }: { threadId: string; disabled: boolean }) {
  const { plugins } = useBitsentryServices();
  const service = useMemo(() => plugins?.listOperations && plugins.approveOperation && plugins.cancelOperation ? {
    list: plugins.listOperations.bind(plugins), approve: plugins.approveOperation.bind(plugins), cancel: plugins.cancelOperation.bind(plugins),
  } : null, [plugins]);
  return service === null ? null : <IntegrationOperationsPanel threadId={threadId} disabled={disabled} service={service} />;
}
export function IntegrationOperationsPanel({ threadId, disabled, service }: { threadId: string; disabled: boolean; service: IntegrationOperationsPort }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [closeRequests, setCloseRequests] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const next = await service.list(threadId); if (active) { setRows(next); setError(false); } } catch { if (active) setError(true); } };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [service, threadId]);
  async function act(row: IntegrationOperation, approve: boolean) {
    setBusy(true); setError(false);
    try {
      if (approve) await service.approve(threadId, row.id, closeRequests[row.id] === true);
      else await service.cancel(threadId, row.id);
      setRows(await service.list(threadId));
    } catch { setError(true); } finally { setBusy(false); }
  }
  if (rows.length === 0 && !error) return null;
  return <section className="max-h-80 shrink-0 overflow-y-auto border-b border-border p-3" aria-label={t("incidents.integrationWrites.title")}>
    {error && <p role="alert">{t("incidents.integrationWrites.error")}</p>}
    {rows.map((row) => <details key={row.id} className="mb-2 rounded border border-border p-3" open={row.status === "proposed" || row.status === "uncertain"}>
      <summary>{row.connectionName} · {row.actionId} · {t(`incidents.integrationWrites.${row.status}`)}</summary>
      <p className="break-all text-sm">{row.target}</p>
      {row.publicUpdate && <p className="font-semibold text-amber-600">{t("incidents.integrationWrites.public")}</p>}
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.input, null, 2)}</pre>
      {(row.status === "uncertain" || row.status === "executing") && <p>{t("incidents.integrationWrites.inspect")}</p>}
      {row.result !== undefined && <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(row.result, null, 2)}</pre>}
      {row.status === "proposed" && <div className="mt-2 flex flex-wrap items-center gap-2">
        {row.requiresCloseRequest && <label><input type="checkbox" checked={closeRequests[row.id] === true} disabled={disabled || busy} onChange={(event) => setCloseRequests((old) => ({ ...old, [row.id]: event.target.checked }))} /> {t("incidents.integrationWrites.closeRequest")}</label>}
        <Button disabled={disabled || busy || (row.requiresCloseRequest && !closeRequests[row.id])} onClick={() => { void act(row, true); }}>{t("incidents.integrationWrites.approve")}</Button>
        <Button variant="outline" disabled={disabled || busy} onClick={() => { void act(row, false); }}>{t("incidents.integrationWrites.cancel")}</Button>
      </div>}
    </details>)}
  </section>;
}
