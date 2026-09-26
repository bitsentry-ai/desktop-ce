import { KnowledgeExecutionPanel } from "./KnowledgeExecutionPanel";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { useBitsentryServices } from "../services/context";
export interface IntegrationResourcesPort { select?(resource: IntegrationResource, selected: boolean): Promise<unknown>; list(threadId: string): Promise<IntegrationResource[]>; }
export function DesktopIntegrationResourcesPanel({ threadId, disabled = false }: { threadId: string; disabled?: boolean }) {
  const { plugins } = useBitsentryServices();
  const service = useMemo(() => plugins?.listResources ? { list: plugins.listResources.bind(plugins), select: plugins.selectResource?.bind(plugins) } : null, [plugins]);
  return service ? <IntegrationResourcesPanel threadId={threadId} service={service} disabled={disabled} /> : null;
}
export function IntegrationResourcesPanel({ threadId, service, disabled = false }: { threadId: string; service: IntegrationResourcesPort; disabled?: boolean }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<IntegrationResource[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const result = await service.list(threadId); if (active) { setRows(result); setFailed(false); } } catch { if (active) setFailed(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [threadId, service]);
  if (!rows.length && !failed) return null;
  return <details className="max-h-60 shrink-0 overflow-y-auto border-b border-border px-4 py-2">
    <summary>{t("incidents.integrationResources.title")} ({rows.length})</summary>
    {failed && <p role="alert">{t("incidents.integrationResources.error")}</p>}
    <div className="flex flex-wrap gap-2 py-2">{rows.map((row) => <article key={`${row.connectionId}:${row.resourceType}:${row.externalId}`} className="max-w-sm rounded border border-border p-2 text-sm">
      {service.select && <label className="mb-1 block"><input type="checkbox" disabled={disabled} checked={row.selected === true} onChange={(event) => { const selected = event.target.checked; void service.select!(row, selected).then(() => service.list(threadId)).then(setRows).catch(() => setFailed(true)); }} /> {t("incidents.knowledge.select")}</label>}
      <a href={row.url} target="_blank" rel="noopener noreferrer" className="font-medium underline">{row.title}</a>
      <p>{row.connectionName} · {row.externalId}</p>
      <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.state, null, 2)}</pre>
      <p className="text-xs text-muted-foreground">{t("incidents.integrationResources.observed")} <time dateTime={row.observedAt}>{new Date(row.observedAt).toLocaleString()}</time></p>
    </article>)}</div>
    {rows.some((row) => row.selected) && <KnowledgeExecutionPanel threadId={threadId} disabled={disabled} />}
  </details>;
}
