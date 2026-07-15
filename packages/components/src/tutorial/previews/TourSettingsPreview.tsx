/**
 * Static preview of the SuperTerminal Settings page for guided tours.
 * Renders hardcoded demo data; no IPC, database, or localStorage access.
 */
// i18n-ignore-file -- scripted demo content for product tour preview
import {
  Bot,
  CheckCircle2,
  Code2,
  DatabaseZap,
  KeyRound,
  Play,
} from "lucide-react";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function ProviderRow({
  name,
  primary,
  children,
}: {
  name: string;
  primary?: boolean;
  children?: React.ReactNode;
}) {
  let primaryBadge: React.ReactNode = null;
  if (primary === true) {
    primaryBadge = (
      <span
        data-tour="settings-coding-agent-primary"
        className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
      >
        Primary
      </span>
    );
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {primaryBadge}
        <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          research lab
        </span>
      </div>
      {children}
    </div>
  );
}

export default function TourSettingsPreview() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-8 py-8">
          <div className="mb-8">
            <h1 className="text-lg font-semibold text-foreground">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure local SuperTerminal settings.
            </p>
          </div>

          <div className="space-y-10">
            <section
              data-tour="settings-external-sources"
              className="space-y-4"
            >
              <div className="flex items-start justify-between gap-4">
                <SectionHeader
                  title="Plugins"
                  description="Connect code-plugin sources for runbook queries."
                />
                <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium">
                  Install Plugin
                </button>
              </div>
              <div className="rounded-lg border border-border">
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <DatabaseZap size={16} className="text-primary" />
                    <div>
                      <div className="text-sm font-medium">
                        Production GitHub Issues
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last sync succeeded - error threshold
                      </div>
                    </div>
                  </div>
                  <button className="rounded-md border border-border px-2 py-1 text-xs">
                    Sync now
                  </button>
                </div>
              </div>
            </section>

            <div className="border-t border-border" />

            <section
              data-tour="settings-global-variables"
              className="space-y-4"
            >
              <div className="flex items-start justify-between gap-4">
                <SectionHeader
                  title="Global Variables"
                  description="Store shared runbook values once and reuse them safely."
                />
                <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium">
                  Add Variable
                </button>
              </div>
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center gap-2 px-4 py-3">
                  <KeyRound size={15} className="text-primary" />
                  <span className="font-mono text-sm font-medium">
                    environment
                  </span>
                  <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    shared
                  </span>
                </div>
                <div className="border-t border-border px-4 py-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1.5 text-xs font-medium">
                      Key
                      <input
                        readOnly
                        value="environment"
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="space-y-1.5 text-xs font-medium">
                      Value
                      <input
                        readOnly
                        value="prod"
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                  <div
                    data-tour="settings-global-variable-reference"
                    className="mt-4 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  >
                    Use as{" "}
                    <code className="rounded bg-background px-1.5 py-0.5 text-foreground">
                      ${"{globals.environment}"}
                    </code>{" "}
                    in Runbooks.
                  </div>
                </div>
              </div>
            </section>

            <div className="border-t border-border" />

            <section data-tour="settings-coding-agents" className="space-y-4">
              <SectionHeader
                title="Coding Agents"
                description="Connect local Codex or Claude Code CLIs for assisted investigation work."
              />
              <div className="overflow-hidden rounded-lg border border-border">
                <ProviderRow name="Codex" primary>
                  <div className="border-t border-border px-4 py-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <label className="space-y-1.5 text-xs font-medium">
                        Binary Path
                        <div className="flex gap-2">
                          <input
                            readOnly
                            value="codex"
                            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                          />
                          <button className="shrink-0 rounded-md border border-border px-3 py-2 text-xs">
                            Detect and Test
                          </button>
                        </div>
                      </label>
                      <label className="space-y-1.5 text-xs font-medium">
                        Default Model
                        <select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
                          <option>GPT-5.3 Codex</option>
                        </select>
                      </label>
                    </div>
                    <label className="mt-4 block space-y-1.5 text-xs font-medium">
                      Extra Args
                      <textarea
                        readOnly
                        value="--profile incident-response"
                        className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </label>
                  </div>
                </ProviderRow>
                <ProviderRow name="Claude Code" />
              </div>
            </section>

            <div className="border-t border-border" />

            <section data-tour="settings-help" className="space-y-4">
              <SectionHeader
                title="Help"
                description="Replay guided tours and onboarding walkthroughs."
              />
              <div className="rounded-lg border border-border divide-y divide-border">
                {["Settings Tour", "Runbook Creation Tour", "Plugins Tour"].map(
                  (label) => (
                    <div
                      key={label}
                      className="flex items-center justify-between px-4 py-3"
                    >
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-primary" />
                        <span className="text-sm font-medium">{label}</span>
                      </div>
                      <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs">
                        <Play size={13} />
                        Replay
                      </button>
                    </div>
                  ),
                )}
              </div>
            </section>

            <section className="hidden">
              <Bot />
              <Code2 />
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
