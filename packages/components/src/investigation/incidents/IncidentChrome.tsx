import { Check } from "lucide-react";
import { statusPillBaseClass, statusToneClass } from "../../lib/plainText";
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

const NO_LLM_PROVIDER_CONFIGURED_MESSAGE =
  "No LLM provider configured. Please configure a provider in Settings.";

function normalizeErrorMessage(errorMsg: string | undefined): string {
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

const SCOPED_STATUS_KEYS: Record<AgentSessionState, string> = {
  IDLE: "common.incidentDetail.incidentIdle",
  RUNNING: "common.incidentDetail.incidentRunning",
  COMPLETED: "common.incidentDetail.incidentCompleted",
  FAILED: "common.incidentDetail.incidentFailed",
  CANCELLED: "common.incidentDetail.incidentCancelled",
};

/**
 * `interrupted`: the last turn stopped because the app closed, which the saved state cannot tell from a stop or a failure.
 * `quiet`: in lists, a completed incident reads as a green check and label rather than a filled pill, so the filled
 * pills that remain mark incidents that need attention.
 * `scoped`: in an incident's header the label names its scope ("Incident completed"), so it never reads as the state
 * of the latest reply.
 */
export function StatusPill({ state, interrupted = false, quiet = false, scoped = false }: { state: AgentSessionState; interrupted?: boolean; quiet?: boolean; scoped?: boolean }) {
  const { t } = useTranslation();
  if (interrupted && (state === "CANCELLED" || state === "FAILED")) {
    return (
      <span className={cn(statusPillBaseClass, statusToneClass.neutral)}>
        {t("common.incidents.statusInterrupted")}
      </span>
    );
  }
  const map: Record<AgentSessionState, { label: string; cls: string }> = {
    IDLE: {
      label: t("common.incidents.statusIdle"),
      cls: statusToneClass.neutral,
    },
    RUNNING: {
      label: t("common.incidents.statusRunning"),
      cls: statusToneClass.running,
    },
    COMPLETED: {
      label: t("common.incidents.statusCompleted"),
      cls: statusToneClass.success,
    },
    FAILED: {
      label: t("common.incidents.statusFailed"),
      cls: statusToneClass.danger,
    },
    CANCELLED: {
      label: t("common.incidents.statusCancelled"),
      cls: statusToneClass.neutral,
    },
  };

  const { cls } = map[state];
  const label = scoped ? t(SCOPED_STATUS_KEYS[state]) : map[state].label;
  if (quiet && state === "COMPLETED") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[hsl(var(--success-text))]">
        <Check size={14} strokeWidth={2.5} aria-hidden="true" />
        {label}
      </span>
    );
  }
  return (
    <span className={cn(statusPillBaseClass, cls)}>
      {label}
    </span>
  );
}

export { EditableTitle } from "./EditableTitle";

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
