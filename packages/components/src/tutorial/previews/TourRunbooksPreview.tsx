/**
 * Static preview of the Runbooks editor view for the guided tour.
 * Renders hardcoded demo data — no database, IPC, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Bot,
  Download,
  Globe,
  GripVertical,
  History,
  Play,
  SquarePen,
  Terminal,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { cn } from "../../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

// ── Action metadata (mirrored from Runbook.tsx) ──────────────────────────────

type ActionType = "shell" | "llm" | "http" | "external_source";

const ACTION_META: Record<
  ActionType,
  { label: string; icon: LucideIcon; badgeCls: string }
> = {
  shell: {
    label: "Shell",
    icon: Terminal,
    badgeCls: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
  },
  llm: {
    label: "AI",
    icon: Bot,
    badgeCls: "text-blue-500 bg-blue-500/10 border-blue-500/20",
  },
  http: {
    label: "HTTP",
    icon: Globe,
    badgeCls: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  },
  external_source: {
    label: "External Source",
    icon: AlertCircle,
    badgeCls: "text-purple-500 bg-purple-500/10 border-purple-500/20",
  },
};

const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[];

// ── Demo data ────────────────────────────────────────────────────────────────

interface DemoAction {
  id: string;
  type: ActionType;
  title: string;
  summary: string;
}

const DEMO_TITLE = "Investigate suspicious egress from db-prod-03";
const DEMO_DESCRIPTION =
  "Collect host evidence, check asset inventory, and summarize likely root cause.";

const DEMO_ACTIONS: DemoAction[] = [
  {
    id: "act-1",
    type: "shell",
    title: "Capture active HTTPS sessions",
    summary: "ss -tpn | grep ':443' | head -20 · 1 param",
  },
  {
    id: "act-2",
    type: "http",
    title: "Fetch asset inventory metadata",
    summary: "GET https://inventory.internal/api/assets/{{host}}",
  },
  {
    id: "act-3",
    type: "llm",
    title: "Summarize the findings",
    summary: "openai/gpt-4.1 · OpenAI",
  },
  {
    id: "act-4",
    type: "external_source",
    title: "Search related production errors",
    summary:
      'No source selected · environment:prod host:{{host}} level:error "db-prod-03"',
  },
];

// ── Tiny components ──────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: ActionType }) {
  const { label, icon: Icon, badgeCls } = ACTION_META[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        badgeCls,
      )}
    >
      <Icon size={9} />
      {label}
    </span>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function TourRunbooksPreview() {
  const { t } = useTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Editor header */}
          <div
            data-tour="runbooks-editor-header"
            className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2"
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{DEMO_TITLE}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {DEMO_DESCRIPTION}
              </div>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {DEMO_ACTIONS.length} actions
            </span>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground lg:block">
              {t("common.tourRunbooksPreview.autoSavesOnBlurDone")}
            </span>
            <button
              data-tour="runbooks-history-btn"
              className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border hover:bg-muted transition-colors"
            >
              <History size={13} />
            </button>
            <button
              data-tour="runbooks-run-btn"
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Play size={13} />
            </button>
            <button className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive transition-colors">
              <Trash2 size={13} />
            </button>
            <button
              data-tour="runbooks-import-btn"
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              <Download size={12} />
              {t("common.actions.import")}
            </button>
            <button
              data-tour="runbooks-new-btn"
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted transition-colors"
            >
              <SquarePen size={12} />
              {t("common.actions.new")}
            </button>
          </div>

          {/* Actions list */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div data-tour="runbooks-actions-list" className="max-w-2xl">
              {DEMO_ACTIONS.map((action, index) => {
                const isExpanded = expandedId === action.id;
                let actionCard: ReactNode;
                if (isExpanded) {
                  let fieldLabel = t("common.tourRunbooksPreview.query");
                  if (action.type === "shell") {
                    fieldLabel = t("common.tourRunbooksPreview.command");
                  } else if (action.type === "llm") {
                    fieldLabel = t("common.tourRunbooksPreview.prompt");
                  } else if (action.type === "http") {
                    fieldLabel = "URL";
                  }

                  actionCard = (
                    <div
                      data-tour="runbooks-action-card"
                      className="rounded-xl border border-primary/40 bg-card px-4 py-4 space-y-3 shadow-sm"
                    >
                      <div
                        data-tour="runbooks-action-types"
                        className="grid grid-cols-4 gap-1.5"
                      >
                        {ACTION_TYPES.map((type) => {
                          const { label, icon: Icon } = ACTION_META[type];
                          let typeClassName =
                            "border-border text-muted-foreground hover:border-border/80 hover:bg-muted/30";
                          if (type === action.type) {
                            typeClassName =
                              "border-primary/50 bg-primary/10 text-primary font-medium";
                          }

                          return (
                            <button
                              key={type}
                              className={cn(
                                "flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-[10px] transition-colors",
                                typeClassName,
                              )}
                            >
                              <Icon size={14} />
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t("common.tourRunbooksPreview.title")}
                        </label>
                        <input
                          readOnly
                          value={action.title}
                          className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {fieldLabel}
                        </label>
                        <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground font-mono">
                          {action.summary}
                        </div>
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                          onClick={() => { setExpandedId(null); }}
                          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted transition-colors"
                        >
                          {t("common.actions.done")}
                        </button>
                      </div>
                    </div>
                  );
                } else {
                  let actionDataTour: string | undefined;
                  if (index === 0) {
                    actionDataTour = "runbooks-first-action";
                  }

                  actionCard = (
                    <div
                      data-tour={actionDataTour}
                      onClick={() => { setExpandedId(action.id); }}
                      className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-all select-none hover:border-border/80 hover:bg-card/80"
                    >
                      <span className="shrink-0 text-muted-foreground/20 group-hover:text-muted-foreground/40 transition-colors">
                        <GripVertical size={14} />
                      </span>
                      <span className="w-4 shrink-0 text-center text-[10px] font-mono text-muted-foreground/40 tabular-nums">
                        {index + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {action.title}
                          </span>
                          <TypeBadge type={action.type} />
                        </div>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {action.summary}
                        </p>
                      </div>
                    </div>
                  );
                }

                let arrowSeparator: ReactNode = null;
                if (index < DEMO_ACTIONS.length - 1 && !isExpanded) {
                  arrowSeparator = (
                    <div className="flex justify-center py-1">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 14 14"
                        className="text-muted-foreground/20"
                      >
                        <path
                          d="M7 2v8M4 7l3 3 3-3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  );
                }

                return (
                  <div key={action.id}>
                    {actionCard}
                    {arrowSeparator}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
