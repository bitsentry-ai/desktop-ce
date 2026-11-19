import { useEffect, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { statusPillBaseClass } from "../lib/plainText";
import { cn } from "../lib/utils";
import { isTurnStalled } from "./turnTimelineRows";
import type { ChatMessage } from "./types";

/** How often a running reply is checked for a stall; the threshold is half an hour, so a minute is plenty. */
const STALL_CHECK_INTERVAL_MS = 60_000;

function latestAgentMessage(messages: readonly ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === "agent") return message;
  }
  return undefined;
}

/**
 * The incident header's status. When the latest reply stopped making progress, the stall replaces the incident's own
 * status (`children`), so the header never says "Incident completed" above a reply that is still hanging. The
 * conversation's stalled row carries the detail and Stop. Only this badge re-renders on its minute clock, and only
 * while the latest reply is running.
 */
export function ResponseStalledBadge({ messages, children }: { messages: readonly ChatMessage[]; children?: ReactNode }) {
  const { t } = useTranslation();
  const latest = latestAgentMessage(messages);
  const running = latest !== undefined && (latest.status === "thinking" || latest.status === "streaming");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNowMs(Date.now());
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, STALL_CHECK_INTERVAL_MS);
    return () => {
      clearInterval(interval);
    };
  }, [running]);

  if (latest === undefined || !isTurnStalled(latest, nowMs)) return <>{children}</>;
  return (
    <span
      className={cn(
        statusPillBaseClass,
        "gap-1 border border-[hsl(var(--warning)/0.35)] before:hidden bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning-text))]",
      )}
    >
      <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
      {t("common.incidentDetail.responseStalled")}
    </span>
  );
}
