import { Ban, CheckCircle2, Clock, XCircle, type LucideIcon } from "lucide-react";

import { cn } from "../lib/utils";
import type { RunOutcome, RunOutcomeTone } from "./runOutcome";

const TONE_ICON: Record<RunOutcomeTone, LucideIcon> = {
  success: CheckCircle2,
  danger: XCircle,
  warning: Ban,
  neutral: Clock,
};

const TONE_ICON_CLASS: Record<RunOutcomeTone, string> = {
  success: "text-[hsl(var(--success-text))]",
  danger: "text-destructive",
  warning: "text-[hsl(var(--warning-text))]",
  neutral: "text-muted-foreground",
};

/**
 * The sentence that leads a run's Summary. The icon carries the tone; the
 * text stays foreground so it reads at a glance in either theme.
 */
export function RunOutcomeLine({ outcome }: { outcome: RunOutcome }) {
  const Icon = TONE_ICON[outcome.tone];
  return (
    <p
      data-tone={outcome.tone}
      className="flex items-start gap-2 text-sm font-medium leading-5 text-foreground"
    >
      <Icon
        size={16}
        aria-hidden="true"
        className={cn("mt-0.5 shrink-0", TONE_ICON_CLASS[outcome.tone])}
      />
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">
        {outcome.text}
      </span>
    </p>
  );
}
