import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import Navbar from "../../layout/Navbar";
import TopBar from "../../layout/TopBar";
import { cn } from "../../lib/utils";
import type { AgentSessionState } from "../../chat/types";

export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  if (iso.length === 0) return "unknown time";

  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "unknown time";

  const diff = nowMs - timestamp;
  if (diff < 0) return "just now"; // Future dates

  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${String(mins)}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${String(hrs)}h ago`;
  return `${String(Math.floor(hrs / 24))}d ago`;
}

export const NO_LLM_PROVIDER_CONFIGURED_MESSAGE =
  "No LLM provider configured. Please configure a provider in Settings.";

export function normalizeErrorMessage(errorMsg: string | undefined): string {
  return (errorMsg ?? "").replace(/^Error:\s*/i, "").trim();
}

export function translateIncidentPreview(
  preview: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (normalizeErrorMessage(preview) === NO_LLM_PROVIDER_CONFIGURED_MESSAGE) {
    return t("common.incidents.noLlmProviderConfigured");
  }
  return preview;
}

// ─── Status pill ──────────────────────────────────────────────────────────────

export function StatusPill({ state }: { state: AgentSessionState }) {
  const { t } = useTranslation();
  const map: Record<AgentSessionState, { label: string; cls: string }> = {
    IDLE: {
      label: t("common.incidents.statusIdle"),
      cls: "bg-muted text-muted-foreground",
    },
    RUNNING: {
      label: t("common.incidents.statusRunning"),
      cls: "bg-amber-500/15 text-amber-500",
    },
    COMPLETED: {
      label: t("common.incidents.statusCompleted"),
      cls: "bg-emerald-500/15 text-emerald-500",
    },
    FAILED: {
      label: t("common.incidents.statusFailed"),
      cls: "bg-destructive/15 text-destructive",
    },
    CANCELLED: {
      label: t("common.incidents.statusCancelled"),
      cls: "bg-muted text-muted-foreground",
    },
  };

  const { label, cls } = map[state];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cls)}>
      {label}
    </span>
  );
}

// ─── Editable title ───────────────────────────────────────────────────────────

export function EditableTitle({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    if (disabled) {
      setEditing(false);
    }
  }, [disabled]);

  const commit = () => {
    const trimmed = draft.trim() || "New Incident";
    setDraft(trimmed);
    onChange(trimmed);
    setEditing(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        onChange={(e) => { setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="flex-1 min-w-0 truncate bg-transparent text-sm font-medium outline-none border-b border-primary/50 focus:border-primary"
      />
    );
  }

  let title = t("common.incidents.clickToRename");
  if (disabled) {
    title = t("common.incidents.archivedIncidentsAreReadOnly");
  }

  return (
    <button
      onClick={() => {
        if (!disabled) {
          setEditing(true);
        }
      }}
      title={title}
      disabled={disabled}
      className={cn(
        "flex-1 min-w-0 truncate text-left text-sm font-medium transition-colors",
        disabled && "cursor-default text-foreground",
        !disabled && "hover:text-muted-foreground",
      )}
    >
      {value}
    </button>
  );
}

// ─── Warning banner ────────────────────────────────────────────────────────────

export function ProviderBanner({
  onNavigateToSettings,
}: {
  onNavigateToSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <AlertTriangle size={16} className="shrink-0 text-amber-500" />
      <div className="flex-1 text-sm">
        <span className="font-medium text-foreground">
          {t("common.incidents.noChatModelIsConfigured")}
        </span>
        <span className="text-muted-foreground">
          {" "}
          {t("common.incidents.addAnApiKeyIn")}
        </span>
      </div>
      <button
        onClick={onNavigateToSettings}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:border-border-hover transition-colors"
      >
        {t("common.incidents.openSettings")}
      </button>
    </div>
  );
}

// ─── Shell shared by both views ───────────────────────────────────────────────

export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Navbar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        {children}
      </div>
    </div>
  );
}
