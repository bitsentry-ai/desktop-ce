import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationOperation } from "@bitsentry-ce/core/features/plugins";
import { Badge } from "../ui/badge";
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
type StatusVariant = "warning" | "info" | "success" | "destructive" | "secondary";
const STATUS_VARIANTS: Record<IntegrationOperation["status"], StatusVariant> = {
  proposed: "warning", executing: "info", succeeded: "success", failed: "destructive", uncertain: "warning", cancelled: "secondary",
};
const MAX_REFUSAL_LENGTH = 300;
const ITOP_FACT_KEYS = ["class", "id", "stimulus"] as const;
const display = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

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

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-all text-sm">{children}</dd></div>;
}

export function IntegrationOperationsPanel({ threadId, disabled, service }: { threadId: string; disabled: boolean; service: IntegrationOperationsPort }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [closeRequests, setCloseRequests] = useState<Record<string, boolean>>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const next = await service.list(threadId); if (active) { setRows(next); setError(false); } } catch { if (active) setError(true); } };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => { active = false; clearInterval(timer); };
  }, [service, threadId]);
  async function act(row: IntegrationOperation, approve: boolean) {
    setBusy(true); setError(false);
    setRefusals((old) => Object.fromEntries(Object.entries(old).filter(([id]) => id !== row.id)));
    try {
      if (approve) await service.approve(threadId, row.id, closeRequests[row.id] === true);
      else await service.cancel(threadId, row.id);
      setRows(await service.list(threadId));
    } catch (caught) {
      // A refusal explains why nothing was written. It belongs to its card and must outlive the 2.5 s list refresh.
      const reason = caught instanceof Error ? caught.message.trim().slice(0, MAX_REFUSAL_LENGTH) : "";
      if (reason === "") setError(true);
      else setRefusals((old) => ({ ...old, [row.id]: reason }));
    } finally { setBusy(false); }
  }
  if (rows.length === 0 && !error) return null;
  return <section className="max-h-[60vh] shrink-0 space-y-2 overflow-y-auto border-b border-border p-3" aria-label={t("incidents.integrationWrites.title")}>
    {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{t("incidents.integrationWrites.error")}</p>}
    {rows.map((row) => {
      const { changes, facts } = summarizeOperation(row);
      const operation = row.ticketOperation === undefined ? row.actionId : t(`incidents.integrationWrites.operation.${row.ticketOperation}`);
      return <details key={row.id} className="group rounded-lg border border-border bg-card" open={row.status === "proposed" || row.status === "uncertain"}>
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <span className="font-medium">{operation}</span>
          <span className="text-muted-foreground">· {row.connectionName}</span>
          <Badge variant={STATUS_VARIANTS[row.status]} className="ml-auto">{t(`incidents.integrationWrites.${row.status}`)}</Badge>
        </summary>
        <div className="space-y-3 border-t border-border px-3 py-3">
          {row.publicUpdate && <p role="note" className="rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">{t("incidents.integrationWrites.public")}</p>}
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Fact label={t("incidents.integrationWrites.target")}>{row.target}</Fact>
            <Fact label={t("incidents.integrationWrites.action")}><code className="text-xs">{row.actionId}</code></Fact>
            {facts.map((fact) => <Fact key={fact.key} label={t(`incidents.integrationWrites.fact.${fact.key}`)}>{fact.value}</Fact>)}
          </dl>
          <div>
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("incidents.integrationWrites.changes")}</h4>
            {changes.length === 0
              ? <p className="text-sm text-muted-foreground">{t("incidents.integrationWrites.noChanges")}</p>
              : <ul className="divide-y divide-border rounded-md border border-border">
                {changes.map((change) => <li key={change.key} className="grid grid-cols-[minmax(6rem,10rem)_1fr] gap-3 px-3 py-2 text-sm">
                  <code className="break-all text-xs text-muted-foreground">{change.key}</code>
                  <span className="whitespace-pre-wrap break-words">{change.value}</span>
                </li>)}
              </ul>}
          </div>
          {(row.status === "uncertain" || row.status === "executing") && <p className="text-sm text-muted-foreground">{t("incidents.integrationWrites.inspect")}</p>}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t("incidents.integrationWrites.details")}</summary>
            <p className="mt-2 font-medium">{t("incidents.integrationWrites.request")}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(row.input, null, 2)}</pre>
            {row.result !== undefined && <>
              <p className="mt-2 font-medium">{t("incidents.integrationWrites.result")}</p>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2">{JSON.stringify(row.result, null, 2)}</pre>
            </>}
          </details>
          {row.status === "proposed" && refusals[row.id] !== undefined && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{refusals[row.id]}</p>}
          {row.status === "proposed" && <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {row.requiresCloseRequest && <label className="mr-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={closeRequests[row.id] === true} disabled={disabled || busy} onChange={(event) => setCloseRequests((old) => ({ ...old, [row.id]: event.target.checked }))} /> {t("incidents.integrationWrites.closeRequest")}</label>}
            <Button size="sm" disabled={disabled || busy || (row.requiresCloseRequest && !closeRequests[row.id])} onClick={() => { void act(row, true); }}>{t("incidents.integrationWrites.approve")}</Button>
            <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => { void act(row, false); }}>{t("incidents.integrationWrites.cancel")}</Button>
          </div>}
        </div>
      </details>;
    })}
  </section>;
}
