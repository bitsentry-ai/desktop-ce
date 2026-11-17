/**
 * Static preview of the Incidents chat view for the guided tour.
 * Renders hardcoded demo data — no database, IPC, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import { useState } from "react";
import {
  ArrowUp,
  FileText,
  History,
  ShieldAlert,
  SquarePen,
  X,
} from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { MarkdownContent } from "../../markdown";
import { cn } from "../../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

// ── Static demo data (inline — no imports from tour-mock-data) ───────────────

const DEMO_TITLE = "Suspicious outbound traffic on port 443";

const DEMO_USER_MSG =
  "Investigate the spike in outbound HTTPS traffic from host db-prod-03.";

const DEMO_AGENT_MSG = `Analysis complete. The outbound HTTPS traffic came from a misconfigured \`vector-agent\` process forwarding metrics to an external collector.

**Root cause:** A recent observability config change replaced the internal collector hostname with an external endpoint.

**Recommendations:**
- Update the shipper config to use the internal sink
- Rotate any exposed credentials
- Verify the egress policy blocks the partner domain`;

const DEMO_ARTIFACTS = [
  {
    key: "exec-1",
    title: "Investigate suspicious egress from db-prod-03",
    status: "completed" as const,
    stepsCompleted: 3,
    stepsTotal: 3,
    latestStep: "Summarize the findings",
    latestStepType: "llm" as const,
  },
  {
    key: "exec-2",
    title: "Rotate leaked API credentials",
    status: "failed" as const,
    stepsCompleted: 1,
    stepsTotal: 2,
    latestStep: "Restart deployment",
    latestStepType: "shell" as const,
  },
];

// ── Tiny inline helpers ──────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  let cls = "bg-muted text-muted-foreground";
  let label = "Idle";
  if (status === "COMPLETED") {
    cls = "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]";
    label = "Completed";
  }

  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {label}
    </span>
  );
}

function ArtifactStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    completed: {
      label: "Completed",
      cls: "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]",
    },
    failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
  };
  const { label, cls } = map[status] ?? {
    label: status,
    cls: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", cls)}
    >
      {label}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function TourIncidentsPreview() {
  const { t } = useTranslation();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState(
    DEMO_ARTIFACTS[0].key,
  );

  let artifactsButtonClassName = "hover:bg-muted";
  let artifactsRailClassName = "translate-x-full";
  if (artifactsOpen) {
    artifactsButtonClassName = "bg-muted text-foreground";
    artifactsRailClassName = "translate-x-0";
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top bar */}
          <div className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2">
            <div data-tour="incidents-title" className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {DEMO_TITLE}
              </span>
            </div>
            <div data-tour="incidents-status">
              <StatusPill status="COMPLETED" />
            </div>

            {/* Artifacts button */}
            <button
              data-tour="incidents-artifacts-btn"
              onClick={() => { setArtifactsOpen((o) => !o); }}
              className={cn(
                "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors",
                artifactsButtonClassName,
              )}
            >
              <FileText size={12} />
              {t("common.tourIncidentsPreview.runbookResults")}
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px]">
                {DEMO_ARTIFACTS.length}
              </span>
            </button>

            <button
              data-tour="incidents-history-btn"
              className="flex size-7 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
            >
              <History size={13} />
            </button>
            <button
              data-tour="incidents-new-btn"
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              <SquarePen size={12} />
              {t("common.actions.new")}
            </button>
          </div>

          {/* Content area with optional rail */}
          <div className="relative flex-1 overflow-hidden">
            <div
              className={cn(
                "flex h-full flex-col transition-[margin] duration-300",
                artifactsOpen && "md:mr-[430px]",
              )}
            >
              {/* Messages */}
              <div className="relative flex-1 overflow-hidden">
                <div className="absolute inset-0 overflow-y-auto px-6 py-6 space-y-5">
                  {/* User message */}
                  <div className="flex justify-end">
                    <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-primary/10 px-4 py-3 text-sm">
                      {DEMO_USER_MSG}
                    </div>
                  </div>
                  {/* Agent message */}
                  <div className="flex gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted/30">
                      <ShieldAlert
                        size={13}
                        className="text-muted-foreground"
                      />
                    </div>
                    <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 text-sm">
                      <MarkdownContent content={DEMO_AGENT_MSG} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Composer */}
              <div className="shrink-0 px-4 pb-4">
                <div
                  data-tour="incidents-composer"
                  className="group rounded-[20px] border bg-card transition-colors duration-200 focus-within:border-ring/45"
                >
                  <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
                    <textarea
                      readOnly
                      placeholder={t(
                        "common.tourIncidentsPreview.describeTheSecurityIssueTo",
                      )}
                      className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                      rows={2}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
                    <div className="flex items-center gap-1">
                      <div
                        data-tour="incidents-model-picker"
                        className="relative z-30 shrink-0"
                      >
                        <button className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground/70 hover:bg-accent sm:px-3">
                          {t("common.tourIncidentsPreview.groqGptOss120b")}
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            className="opacity-50"
                          >
                            <path
                              d="M2 4l3 3 3-3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                    <div
                      data-tour="incidents-send-btn"
                      className="flex shrink-0 items-center gap-2"
                    >
                      <button className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground cursor-not-allowed opacity-30">
                        <ArrowUp size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Artifacts rail */}
            <aside
              data-tour="incidents-artifacts-rail"
              className={cn(
                "absolute inset-y-0 right-0 z-20 flex w-full max-w-[430px] flex-col border-l border-border bg-background/95 shadow-2xl backdrop-blur transition-transform duration-300",
                artifactsRailClassName,
              )}
            >
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div className="flex size-9 items-center justify-center rounded-2xl border border-border bg-muted/20">
                  <FileText size={16} className="text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">
                    {t("common.tourIncidentsPreview.runbookResults_2")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {DEMO_ARTIFACTS.length}{" "}
                    {t("common.tourIncidentsPreview.runbookExecutions")}
                  </div>
                </div>
                <button
                  onClick={() => { setArtifactsOpen(false); }}
                  className="flex size-8 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>

              <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,0.9fr)_minmax(0,1.4fr)]">
                <div
                  data-tour="incidents-artifacts-list"
                  className="min-h-0 overflow-y-auto px-4 py-4"
                >
                  <div className="space-y-2">
                    {DEMO_ARTIFACTS.map((a) => {
                      let artifactClassName =
                        "border-border hover:border-border/80 hover:bg-muted/30";
                      if (selectedArtifact === a.key) {
                        artifactClassName = "border-primary/30 bg-primary/5";
                      }

                      let artifactStatusText = "completed";
                      if (a.status === "failed") {
                        artifactStatusText = "failed";
                      }

                      return (
                        <button
                          key={a.key}
                          type="button"
                          onClick={() => { setSelectedArtifact(a.key); }}
                          className={cn(
                            "flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                            artifactClassName,
                          )}
                        >
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted/20">
                            <FileText
                              size={14}
                              className="text-muted-foreground"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium">
                                {a.title}
                              </span>
                              <ArtifactStatusBadge status={a.status} />
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {a.stepsCompleted}/{a.stepsTotal}{" "}
                              {t("common.tourIncidentsPreview.stepsComplete")}
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground/70">
                              <span>→</span>
                              <span className="truncate">{a.latestStep}</span>
                              <span className="text-muted-foreground/40">
                                {artifactStatusText}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  data-tour="incidents-artifacts-detail"
                  className="min-h-0 px-4 pb-4"
                >
                  <div className="h-full overflow-y-auto rounded-2xl border border-border bg-muted/10 px-4 py-4">
                    {(() => {
                      const a = DEMO_ARTIFACTS.find(
                        (x) => x.key === selectedArtifact,
                      );
                      if (a === undefined) return null;

                      let artifactStatusText = "completed";
                      if (a.status === "failed") {
                        artifactStatusText = "failed";
                      }

                      return (
                        <div className="space-y-3 text-sm">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">
                              {a.title}
                            </span>
                            <ArtifactStatusBadge status={a.status} />
                          </div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-foreground/50">
                            {t("common.tourIncidentsPreview.latestStep")}
                          </div>
                          <div className="rounded-lg border border-border px-3 py-2 text-xs">
                            <span className="font-medium">{a.latestStep}</span>
                            <span className="ml-2 text-muted-foreground">
                              {a.latestStepType} · {artifactStatusText}
                            </span>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
