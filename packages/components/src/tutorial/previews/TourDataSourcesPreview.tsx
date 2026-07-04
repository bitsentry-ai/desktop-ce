/**
 * Static preview of plugin setup and runbook usage.
 * Renders hardcoded demo data; no database, IPC, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import {
  AlertCircle,
  Bot,
  Check,
  DatabaseZap,
  Globe,
  Play,
  Terminal,
} from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { cn } from "../../lib/utils";

const providerCards = ["GitHub Issues", "Error Events", "Alert Index"];
const actionTypes = [
  { id: "shell", label: "Shell", icon: Terminal },
  { id: "llm", label: "AI", icon: Bot },
  { id: "http", label: "HTTP", icon: Globe },
  { id: "external_source", label: "External Source", icon: AlertCircle },
] as const;

export default function TourDataSourcesPreview() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto">
          <div className="grid min-h-full grid-cols-1 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
            <section className="border-b border-border px-6 py-6 lg:border-b-0 lg:border-r">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-semibold text-foreground">
                    Plugins
                  </h1>
                  <p className="text-sm text-muted-foreground">
                    Connect telemetry providers that Runbooks can query.
                  </p>
                </div>
                <button
                  data-tour="data-sources-add-source"
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-medium"
                >
                  Install Plugin
                </button>
              </div>

              <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
                <div className="mb-4">
                  <h2 className="text-sm font-semibold text-foreground">
                    Connect External Source
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    Credentials stay local to the desktop app.
                  </p>
                </div>

                <div
                  data-tour="data-sources-provider-picker"
                  className="space-y-2"
                >
                  <label className="text-sm text-muted-foreground">
                    Source Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {providerCards.map((provider) => {
                      const selected = provider === "GitHub Issues";
                      let cardClassName = "border-border bg-card";
                      let iconClassName = "text-muted-foreground";
                      if (selected) {
                        cardClassName =
                          "border-primary bg-primary/10 ring-1 ring-primary";
                        iconClassName = "text-primary";
                      }

                      return (
                        <button
                          key={provider}
                          className={cn(
                            "flex flex-col items-center gap-2 rounded-lg border p-3 text-sm transition-colors",
                            cardClassName,
                          )}
                        >
                          <DatabaseZap size={26} className={iconClassName} />
                          <span className="font-medium">{provider}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div
                  data-tour="data-sources-credentials"
                  className="mt-4 space-y-3"
                >
                  <label className="block space-y-1">
                    <span className="text-sm text-muted-foreground">Name</span>
                    <input
                      readOnly
                      value="Production GitHub Issues"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-sm text-muted-foreground">
                      Auth Token
                    </span>
                    <input
                      readOnly
                      type="password"
                      value="saved-secret"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    />
                  </label>
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="block space-y-1">
                      <span className="text-sm text-muted-foreground">
                        Organization
                      </span>
                      <input
                        readOnly
                        value="bitsentry-ai"
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-sm text-muted-foreground">
                        Repositories
                      </span>
                      <input
                        readOnly
                        value="monorepo, runbooks"
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                  <div className="flex justify-end">
                    <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                      Connect Source
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <section className="px-6 py-6">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    Runbook Action
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Reference the connected source from an External Source
                    action.
                  </p>
                </div>
                <button className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Play size={14} />
                </button>
              </div>

              <div className="rounded-xl border border-primary/40 bg-card px-4 py-4 shadow-sm">
                <div
                  data-tour="data-sources-runbook-action-type"
                  className="grid grid-cols-4 gap-1.5"
                >
                  {actionTypes.map(({ id, label, icon: Icon }) => {
                    let actionClassName = "border-border text-muted-foreground";
                    if (id === "external_source") {
                      actionClassName =
                        "border-primary bg-primary/5 text-foreground";
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
                    <span className="block text-[10px] font-medium uppercase text-muted-foreground/60">
                      Title
                    </span>
                    <input
                      readOnly
                      value="Search production errors for the host"
                      className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm outline-none"
                    />
                  </label>

                  <label
                    data-tour="data-sources-runbook-selector"
                    className="block space-y-1.5"
                  >
                    <span className="block text-[10px] font-medium uppercase text-muted-foreground/60">
                      External Source
                    </span>
                    <select className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs">
                      <option>Production GitHub Issues (github)</option>
                    </select>
                    <p className="text-[11px] text-muted-foreground">
                      Connected sources from Settings appear here.
                    </p>
                  </label>

                  <label
                    data-tour="data-sources-runbook-query"
                    className="block space-y-1.5"
                  >
                    <span className="block text-[10px] font-medium uppercase text-muted-foreground/60">
                      Query
                    </span>
                    <input
                      readOnly
                      value={
                        "environment:${globals.environment} host:{{host}} level:error"
                      }
                      className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Mix Global Variables with runtime parameters to reuse the
                      same Runbook across environments and hosts.
                    </p>
                  </label>
                </div>

                <div className="mt-4 flex justify-end">
                  <button className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
                    <Check size={11} />
                    Done
                  </button>
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
