import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { IntegrationResource } from "@bitsentry-ce/core/features/plugins";
import { useBitsentryServices } from "../services/context";
export interface IntegrationResourcesPort { list(threadId: string): Promise<IntegrationResource[]>; }
export function DesktopIntegrationResourcesPanel({ threadId }: { threadId: string }) {
  const { plugins } = useBitsentryServices();
  const service = useMemo(() => plugins?.listResources ? { list: plugins.listResources.bind(plugins) } : null, [plugins]);
  return service ? <IntegrationResourcesPanel threadId={threadId} service={service} /> : null;
}
export function IntegrationResourcesPanel({ threadId, service }: { threadId: string; service: IntegrationResourcesPort }) {
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
      <a href={row.url} target="_blank" rel="noopener noreferrer" className="font-medium underline">{row.title}</a>
      <p>{row.connectionName} · {row.externalId}</p>
      <pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(row.state, null, 2)}</pre>
      <p className="text-xs text-muted-foreground">{t("incidents.integrationResources.observed")} <time dateTime={row.observedAt}>{new Date(row.observedAt).toLocaleString()}</time></p>
    </article>)}</div>
  </details>;
}
