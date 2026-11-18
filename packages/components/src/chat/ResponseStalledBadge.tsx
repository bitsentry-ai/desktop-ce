import { useEffect, useState } from "react";
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
 * Shown beside the incident's status when its latest reply stopped making progress, so the header says both what the
 * incident is (for example Completed) and that the response under way has stalled. It renders nothing otherwise. Only
 * this badge re-renders on its minute clock, and only while the latest reply is running.
 */
export function ResponseStalledBadge({ messages }: { messages: readonly ChatMessage[] }) {
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

  if (latest === undefined || !isTurnStalled(latest, nowMs)) return null;
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
