/**
 * Static preview of the Results detail view for the guided tour.
 * Renders hardcoded demo data — no database, IPC, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import { useState, type ReactNode } from "react";
import { AlertCircle, Bot, Globe, History, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { MarkdownContent } from "../../markdown";
import { cn } from "../../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

// ── Demo data ────────────────────────────────────────────────────────────────

interface DemoStep {
  id: string;
  order: number;
  type: "shell" | "llm" | "http" | "external_source";
  title: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
  input?: Record<string, unknown>;
}

const RUNBOOK_TITLE = "Investigate suspicious egress from db-prod-03";
const EXECUTION_ID = "__tour_demo__res-1";
const EXECUTION_STATUS = "completed";

const DEMO_STEPS: DemoStep[] = [
  {
    id: "step-1",
    order: 1,
    type: "shell",
    title: "Capture active HTTPS sessions",
    status: "completed",
    input: { command: "ss -tpn | grep ':443' | head -20" },
    output:
      'ESTAB 0 0 10.0.2.15:52412 198.51.100.44:443 users:(("vector",pid=812,fd=18))',
  },
  {
    id: "step-2",
    order: 2,
    type: "http",
    title: "Fetch asset inventory metadata",
    status: "completed",
    input: { url: "https://inventory.internal/api/assets/db-prod-03" },
    output:
      '{"asset":"db-prod-03","owner":"platform-observability","environment":"prod"}',
  },
  {
    id: "step-3",
    order: 3,
    type: "llm",
    title: "Summarize the findings",
    status: "completed",
    output:
      "The traffic originated from `vector-agent`, not the database itself. A recent observability config change pointed the shipper at an external collector. Remediate by restoring the internal sink, then confirm egress is blocked for the external hostname.",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

const TYPE_ICONS: Record<string, LucideIcon> = {
  shell: Terminal,
  llm: Bot,
  http: Globe,
  external_source: AlertCircle,
};

const TYPE_LABELS: Record<string, string> = {
  shell: "Shell",
  llm: "AI",
  http: "HTTP",
  external_source: "External",
};

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success-text))]";
    case "failed":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

// ── Component ────────────────────────────────────────────────────────────────

export default function TourResultsPreview() {
  const { t } = useTranslation();
  const [selectedStepId, setSelectedStepId] = useState(DEMO_STEPS[0].id);
  const selectedStep = DEMO_STEPS.find((s) => s.id === selectedStepId) ?? null;

  let outputContent: ReactNode = (
    <p className="text-xs italic text-muted-foreground">
      {t("common.tourResultsPreview.selectAStepToInspect")}
    </p>
  );

  if (selectedStep !== null) {
    let inputContent: ReactNode = null;
    if (selectedStep.input !== undefined) {
      inputContent = (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {t("common.tourResultsPreview.input")}
          </div>
          <pre className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(selectedStep.input, null, 2)}
          </pre>
        </div>
      );
    }

    let markdownOutputContent: ReactNode = null;
    if (selectedStep.output !== undefined) {
      markdownOutputContent = (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {t("common.tourResultsPreview.output_2")}
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
            <MarkdownContent content={selectedStep.output} />
          </div>
        </div>
      );
    }

    let errorContent: ReactNode = null;
    if (selectedStep.error !== undefined) {
      errorContent = (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {t("common.tourResultsPreview.error")}
          </div>
          <pre className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs font-mono text-destructive whitespace-pre-wrap">
            {selectedStep.error}
          </pre>
        </div>
      );
    }

    outputContent = (
      <div className="min-w-0 space-y-3">
        {inputContent}
        {markdownOutputContent}
        {errorContent}
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Header */}
          <div className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            <button
              data-tour="results-runbooks-btn"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {RUNBOOK_TITLE}
            </button>
            <span className="text-muted-foreground/30">/</span>
            <span className="font-mono text-xs text-muted-foreground">
              {EXECUTION_ID.slice(0, 8)}
            </span>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium",
                statusClass(EXECUTION_STATUS),
              )}
            >
              {statusLabel(EXECUTION_STATUS)}
            </span>
            <div className="flex-1" />
            <button
              data-tour="results-history-btn"
              className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
            >
              <History size={13} />
            </button>
          </div>

          {/* Three-column panel layout */}
          <div className="flex min-h-0 flex-1 flex-col divide-y divide-border overflow-y-auto lg:flex-row lg:divide-x lg:divide-y-0 lg:overflow-hidden">
            {/* Summary panel */}
            <div className="min-w-0 shrink-0 lg:flex-1 lg:shrink lg:overflow-hidden">
              <div data-tour="results-summary" className="flex h-full flex-col">
                <div className="shrink-0 border-b border-border px-4 py-3">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {t("common.tourResultsPreview.summary")}
                  </h3>
                </div>
                <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {t("common.tourResultsPreview.runbook")}
                    </span>
                    <div className="font-medium">{RUNBOOK_TITLE}</div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {t("common.tourResultsPreview.status")}
                    </span>
                    <div>
                      <span
                        className={cn(
                          "rounded-full px-2 py-0.5 text-xs font-medium",
                          statusClass(EXECUTION_STATUS),
                        )}
                      >
                        {statusLabel(EXECUTION_STATUS)}
                      </span>
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {t("common.tourResultsPreview.steps")}
                    </span>
                    <div>
                      {
                        DEMO_STEPS.filter((s) => s.status === "completed")
                          .length
                      }
                      /{DEMO_STEPS.length} completed
                    </div>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">
                      {t("common.tourResultsPreview.parameters")}
                    </span>
                    <pre className="mt-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs font-mono">
                      {JSON.stringify({ host: "db-prod-03" }, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>

            {/* Steps panel */}
            <div className="min-w-0 shrink-0 lg:flex-1 lg:shrink lg:overflow-hidden">
              <div data-tour="results-steps" className="flex h-full flex-col">
                <div className="shrink-0 border-b border-border px-4 py-3">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {t("common.tourResultsPreview.steps_2")}
                  </h3>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
                  {DEMO_STEPS.map((step) => {
                    const Icon = TYPE_ICONS[step.type] ?? Terminal;
                    const isSelected = step.id === selectedStepId;
                    let stepClassName = "border-border hover:bg-muted/30";
                    if (isSelected) {
                      stepClassName = "border-primary/30 bg-primary/5";
                    }

                    let statusClassName = "text-destructive";
                    if (step.status === "completed") {
                      statusClassName = "text-primary";
                    }

                    return (
                      <button
                        key={step.id}
                        onClick={() => { setSelectedStepId(step.id); }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors",
                          stepClassName,
                        )}
                      >
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/20">
                          <Icon size={13} className="text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">
                              {step.title}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {TYPE_LABELS[step.type]} ·{" "}
                            <span className={statusClassName}>
                              {step.status}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Output panel */}
            <div className="min-w-0 shrink-0 lg:flex-[1.35] lg:shrink lg:overflow-hidden">
              <div data-tour="results-output" className="flex h-full flex-col">
                <div className="shrink-0 border-b border-border px-4 py-3">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {t("common.tourResultsPreview.output")}
                  </h3>
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4">
                  {outputContent}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
