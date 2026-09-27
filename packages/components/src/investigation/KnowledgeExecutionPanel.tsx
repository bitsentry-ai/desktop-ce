import { useEffect, useState } from "react";
import { z } from "zod";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { RunbookRecord, RunbookExecutionRecord } from "../services/contracts";
import { useBitsentryServices } from "../services/context";
import { Button } from "../ui/button";
export function KnowledgeExecutionPanel({ threadId, disabled }: { threadId: string; disabled: boolean }) {
  const { runbooks } = useBitsentryServices();
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<RunbookRecord[]>([]);
  const [selected, setSelected] = useState<RunbookRecord | null>(null);
  const [parameters, setParameters] = useState("{}");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [execution, setExecution] = useState<RunbookExecutionRecord | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const rows = await runbooks.list(); if (active) setCatalog(rows); } catch { if (active) setError(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [runbooks]);
  useEffect(() => {
    if (!executionId) return;
    let active = true;
    const refresh = async () => { try { const value = await runbooks.getExecution(executionId); if (active) setExecution(value); } catch { if (active) setError(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [executionId, runbooks]);
  async function execute() {
    if (!selected || !approved || disabled || busy) return;
    setBusy(true); setError(false);
    try {
      const values = z.record(z.string(), z.string()).parse(JSON.parse(parameters));
      const canonical = JSON.stringify([threadId, selected.id, selected.revisionNumber, Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
      // i18n-ignore-next-line -- Internal idempotency key prefix, never displayed.
      const requestKey = "knowledge:" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await runbooks.execute({ runbookId: selected.id, expectedRevisionNumber: selected.revisionNumber, requestKey, incidentThreadId: threadId, parameterValues: values });
      setExecutionId(result.executionId); setApproved(false);
    } catch { setError(true); } finally { setBusy(false); }
  }
  return <section className="space-y-2 border-t border-border py-2">
    <p className="font-medium">{t("incidents.knowledge.executeTitle")}</p>
    {error && <p role="alert">{t("incidents.knowledge.executeError")}</p>}
    <select className="max-w-full rounded border border-border bg-background p-1" aria-label={t("incidents.knowledge.runbook")} value={selected?.id ?? ""} disabled={disabled || busy} onChange={(event) => { setSelected(catalog.find((row) => row.id === event.target.value) ?? null); setApproved(false); }}>
      <option value="">{t("incidents.knowledge.runbook")}</option>
      {catalog.map((row) => <option key={row.id} value={row.id}>{row.title} · {row.id}</option>)}
    </select>
    {selected && <>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify({ title: selected.title, revision: selected.revisionNumber, actions: selected.actions }, null, 2)}</pre>
      <textarea className="w-full rounded border border-border bg-background p-2 font-mono text-xs" aria-label={t("incidents.knowledge.parameters")} value={parameters} disabled={disabled || busy} onChange={(event) => { setParameters(event.target.value); setApproved(false); }} />
      <label className="block"><input type="checkbox" checked={approved} disabled={disabled || busy} onChange={(event) => setApproved(event.target.checked)} /> {t("incidents.knowledge.approveExecution")}</label>
      <Button disabled={disabled || busy || !approved} onClick={() => { void execute(); }}>{t("incidents.knowledge.execute")}</Button>
    </>}
    {execution && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(execution, null, 2)}</pre>}
  </section>;
}
