/**
 * Static preview of runbook creation with Global Variables.
 * Renders hardcoded demo data; no database, IPC, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import {
  Bot,
  Check,
  Globe,
  History,
  Play,
  Plus,
  SquarePen,
  Terminal,
} from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { cn } from "../../lib/utils";

const actionTypes = [
  { id: "shell", label: "Shell", icon: Terminal },
  { id: "llm", label: "AI", icon: Bot },
  { id: "http", label: "HTTP", icon: Globe },
  { id: "external_source", label: "External Source", icon: Globe },
] as const;

export default function TourRunbookCreationPreview() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            data-tour="runbook-create-header"
            className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2"
          >
            <div className="min-w-0 flex-1">
              <input
                readOnly
                value="Investigate production host health"
                className="w-full bg-transparent text-sm font-medium outline-none"
              />
              <input
                readOnly
                value="Use shared environment settings and runtime host input."
                className="mt-0.5 w-full bg-transparent text-xs text-muted-foreground outline-none"
              />
            </div>
            <span className="hidden shrink-0 text-[11px] text-muted-foreground md:block">
              Auto-saves on Done
            </span>
            <button className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border">
              <History size={13} />
            </button>
            <button
              data-tour="runbook-create-run"
              className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <Play size={13} />
            </button>
            <button className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
              <SquarePen size={12} />
              New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-6">
            <div className="max-w-2xl">
              <div className="rounded-xl border border-primary/40 bg-card px-4 py-4 shadow-sm">
                <div
                  data-tour="runbook-create-action-type"
                  className="grid grid-cols-4 gap-1.5"
                >
                  {actionTypes.map(({ id, label, icon: Icon }) => {
                    let actionClassName = "border-border text-muted-foreground";
                    if (id === "shell") {
                      actionClassName = "border-primary bg-primary/5 text-foreground";
                    }

                    return (
                      <button
                        key={id}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 text-xs transition-colors",
                          actionClassName,
                        )}
                      >
                        <Icon size={13} />
                        {label}
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 space-y-4">
                  <label className="block space-y-1.5">
                    <span className="block text-[10px] font-medium uppercase text-muted-foreground">
                      Title
                    </span>
                    <input
                      readOnly
                      value="Check service logs for the selected host"
                      className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none"
                    />
                  </label>

                  <label data-tour="runbook-create-global-reference" className="block space-y-1.5">
                    <span className="block text-[10px] font-medium uppercase text-muted-foreground">
                      Command
                    </span>
                    <textarea
                      readOnly
                      rows={4}
                      value={
                        "journalctl -u app --since \"30 minutes ago\" | grep ${globals.environment} | grep {{host}} | tail -100"
                      }
                      className="w-full resize-none rounded-lg border border-border bg-muted/20 px-3 py-2 font-mono text-xs leading-relaxed outline-none"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Global Variables use{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        ${"{globals.environment}"}
                      </code>
                      . Runtime parameters use{" "}
                      <code className="rounded bg-muted px-1 py-0.5">
                        {"{{host}}"}
                      </code>
                      .
                    </p>
                  </label>

                  <div data-tour="runbook-create-parameters">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-medium uppercase text-muted-foreground">
                        Parameters
                      </span>
                      <button className="text-[10px] uppercase text-muted-foreground">
                        Add Parameter
                      </button>
                    </div>
                    <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 md:grid-cols-[1fr_1fr_auto]">
                      <input
                        readOnly
                        value="host"
                        className="rounded-md border border-border bg-background px-3 py-2 text-xs"
                      />
                      <input
                        readOnly
                        value="db-prod-03"
                        className="rounded-md border border-border bg-background px-3 py-2 text-xs"
                      />
                      <span className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
                        required
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between pt-1">
                  <button className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground">
                    <Plus size={11} />
                    Add action here
                  </button>
                  <button className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                    <Check size={11} />
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
