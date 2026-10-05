import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { RunbookRecord, RunbookExecutionRecord } from "../services/contracts";
import { useBitsentryServices } from "../services/context";
import { formatDuration } from "../chat/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { RunbookPicker } from "./RunbookPicker";
import { Textarea } from "../ui/textarea";

const sameReviewedSteps = (a: RunbookRecord, b: RunbookRecord) => a.revisionNumber === b.revisionNumber && JSON.stringify(a.actions) === JSON.stringify(b.actions);

type RunbookAction = RunbookRecord["actions"][number];
/** What a step will do, in words the engineer can review; never headers, bodies or credentials. */
function describeAction(action: RunbookAction): string {
  if (action.command) return action.command;
  if (action.url) return `${action.method ?? "GET"} ${action.url}`;
  if (action.prompt) return action.prompt;
  return [action.pluginId, action.pluginActionId].filter(Boolean).join(":");
}
const STATUS_LABEL_KEYS: Record<string, string> = { claim_expired: "claimExpired" };
function statusVariant(status: string): "success" | "destructive" | "info" | "secondary" {
  if (status === "completed") return "success";
  if (status === "failed" || status === "claim_expired") return "destructive";
  if (status === "running" || status === "queued" || status === "pending") return "info";
  return "secondary";
}
function executionOutput(execution: RunbookExecutionRecord): string {
  return execution.steps
    .flatMap((step) => [step.output, step.error].filter((text): text is string => typeof text === "string" && text.trim() !== "").map((text) => `${step.title}\n${text}`))
    .join("\n\n");
}

function StepList({ actions, revision }: { actions: RunbookAction[]; revision: number | undefined }) {
  const { t } = useTranslation();
  return <div className="space-y-1.5">
    <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {t("incidents.knowledge.steps")}
      {revision !== undefined && <span className="font-normal normal-case">{t("incidents.knowledge.revision", { revision })}</span>}
    </p>
    <ol className="space-y-1.5">
      {actions.map((action, index) => <li key={action.id} className="flex gap-2 rounded-md border border-border bg-card p-2 text-sm">
        <span className="w-5 shrink-0 text-right text-xs text-muted-foreground">{index + 1}.</span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2"><span className="min-w-0 truncate font-medium">{action.title}</span><Badge variant="secondary" className="shrink-0">{action.type}</Badge></div>
          {describeAction(action) !== "" && <code className="block break-all rounded bg-muted px-1.5 py-1 font-mono text-xs">{describeAction(action)}</code>}
        </div>
      </li>)}
    </ol>
  </div>;
}

function ExecutionResult({ execution }: { execution: RunbookExecutionRecord }) {
  const { t } = useTranslation();
  const output = executionOutput(execution);
  const took = execution.completedAt === undefined ? null : formatDuration(new Date(execution.completedAt).getTime() - new Date(execution.startedAt).getTime());
  return <div className="space-y-2 rounded-lg border border-border bg-card p-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{execution.runbookTitle}</span>
      <Badge variant={statusVariant(execution.status)}>{t(`common.incidentArtifactsRail.status.${STATUS_LABEL_KEYS[execution.status] ?? execution.status}`)}</Badge>
      {took !== null && <span className="text-xs text-muted-foreground">{t("incidents.knowledge.duration", { time: took })}</span>}
    </div>
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("incidents.knowledge.output")}</p>
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{output === "" ? t("incidents.knowledge.noOutput") : output}</pre>
  </div>;
}

/**
 * Stays mounted once it exists: an execution that is still running keeps being polled, and its result stays reachable,
 * even when nothing is selected any more. `active` only decides whether the review controls are shown. A host that
 * labels the review itself can hide the title.
 */
export function KnowledgeExecutionPanel({ threadId, disabled, active = true, hideTitle = false }: { threadId: string; disabled: boolean; active?: boolean; hideTitle?: boolean }) {
  const { runbooks } = useBitsentryServices();
  const { t } = useTranslation();
  const parametersId = useId();
  const [catalog, setCatalog] = useState<RunbookRecord[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [selected, setSelected] = useState<RunbookRecord | null>(null);
  const [parameters, setParameters] = useState("{}");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [executeError, setExecuteError] = useState(false);
  const [changed, setChanged] = useState(false);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [execution, setExecution] = useState<RunbookExecutionRecord | null>(null);
  // One explicit Run click owns one key: it is kept only while that same click is retried, and dropped once it is accepted.
  const attempt = useRef<{ canonical: string; nonce: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const refresh = async () => { try { const rows = await runbooks.list(); if (alive) { setCatalog(rows); setCatalogLoaded(true); setLoadError(false); } } catch { if (alive) { setCatalogLoaded(true); setLoadError(true); } } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [runbooks, active]);
  // The approval covers exactly the steps that were shown. When they change, or the runbook disappears, it no longer applies.
  useEffect(() => {
    if (!selected) return;
    const fresh = catalog.find((row) => row.id === selected.id);
    if (fresh !== undefined && sameReviewedSteps(fresh, selected)) return;
    setSelected(fresh ?? null); setApproved(false); setChanged(true);
  }, [catalog, selected]);
  useEffect(() => {
    if (!executionId) return;
    let alive = true;
    const refresh = async () => { try { const value = await runbooks.getExecution(executionId); if (alive) { setExecution(value); setLoadError(false); } } catch { if (alive) setLoadError(true); } };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [executionId, runbooks]);
  async function execute() {
    if (!selected || !approved || disabled || busy) return;
    setBusy(true); setExecuteError(false);
    try {
      const values = z.record(z.string(), z.string()).parse(JSON.parse(parameters));
      const canonical = JSON.stringify([threadId, selected.id, selected.revisionNumber, Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
      if (attempt.current?.canonical !== canonical) attempt.current = { canonical, nonce: crypto.randomUUID() };
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical + attempt.current.nonce)));
      // i18n-ignore-next-line -- Internal idempotency key prefix, never displayed.
      const requestKey = "knowledge:" + Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await runbooks.execute({ runbookId: selected.id, expectedRevisionNumber: selected.revisionNumber, requestKey, incidentThreadId: threadId, parameterValues: values });
      attempt.current = null;
      setExecutionId(result.executionId); setApproved(false);
    } catch { setExecuteError(true); } finally { setBusy(false); }
  }
  if (!active && executionId === null) return null;
  return <section aria-label={t("incidents.knowledge.executeTitle")} className="space-y-3 border-t border-border pt-3">
    {!hideTitle && <h3 className="text-sm font-semibold">{t("incidents.knowledge.executeTitle")}</h3>}
    {executeError && <p role="alert" className="text-sm text-destructive">{t("incidents.knowledge.executeError")}</p>}
    {loadError && <p role="alert" className="text-sm text-destructive">{t("incidents.knowledge.loadError")}</p>}
    {changed && <p role="status" className="text-sm text-muted-foreground">{t("incidents.knowledge.changed")}</p>}
    {active && <>
      <RunbookPicker runbooks={catalog} selectedId={selected?.id ?? null} loading={!catalogLoaded} loadFailed={loadError} disabled={disabled || busy}
        onSelect={(id) => { setSelected(catalog.find((row) => row.id === id) ?? null); setApproved(false); setChanged(false); }} />
      {selected && <>
        <StepList actions={selected.actions} revision={selected.revisionNumber} />
        <div className="space-y-1.5">
          <Label htmlFor={parametersId}>{t("incidents.knowledge.parameters")}</Label>
          <Textarea id={parametersId} className="font-mono text-xs" value={parameters} disabled={disabled || busy} onChange={(event) => { setParameters(event.target.value); setApproved(false); }} />
        </div>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 accent-primary" checked={approved} disabled={disabled || busy} onChange={(event) => { setApproved(event.target.checked); }} /> {t("incidents.knowledge.approveExecution")}</label>
        <Button disabled={disabled || busy || !approved} onClick={() => { void execute(); }}>{t("incidents.knowledge.execute")}</Button>
      </>}
    </>}
    {execution && <ExecutionResult execution={execution} />}
  </section>;
}
