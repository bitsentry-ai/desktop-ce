import * as HoverCard from "@radix-ui/react-hover-card";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";

interface ContextIndicatorProps {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextLimit?: number;
  providerDisplayName?: string;
  usageUnavailable?: boolean;
  className?: string;
}

function formatK(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${String(Math.round(value / 1_000))}k`;
  return String(value);
}

function formatVerbose(value: number): string {
  return value.toLocaleString();
}

function getUsageRatio(
  total: number,
  contextLimit: number | undefined,
  usageUnavailable: boolean,
): number | null {
  if (usageUnavailable || contextLimit === undefined || contextLimit <= 0) {
    return null;
  }
  return total / contextLimit;
}

function getUsageClasses(
  usageRatio: number | null,
): { ringClass: string; textClass: string } {
  if (usageRatio !== null && usageRatio > 1) {
    return { ringClass: "stroke-destructive", textClass: "text-destructive" };
  }
  if (usageRatio !== null && usageRatio > 0.8) {
    return {
      ringClass: "stroke-amber-500",
      textClass: "text-amber-600 dark:text-amber-400",
    };
  }
  return {
    ringClass: "stroke-muted-foreground/60",
    textClass: "text-muted-foreground/70",
  };
}

export function ContextIndicator({
  inputTokens,
  outputTokens,
  contextTokens,
  contextLimit,
  providerDisplayName,
  usageUnavailable = false,
  className,
}: ContextIndicatorProps) {
  const { t } = useTranslation();
  const requestTotal = inputTokens + outputTokens;
  const total = contextTokens ?? requestTotal;
  const hasContextLimit = contextLimit !== undefined && contextLimit > 0;
  if (total === 0 && requestTotal === 0 && !hasContextLimit) return null;

  const usageRatio = getUsageRatio(total, contextLimit, usageUnavailable);
  const contextPercentage = hasContextLimit
    ? Math.round((total / contextLimit) * 100)
    : 0;
  const progressPercentage = Math.min(Math.max(contextPercentage, 0), 100);
  const displayValue = usageUnavailable && hasContextLimit
    ? "?"
    : usageRatio === null
      ? formatK(total)
      : String(contextPercentage);
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (progressPercentage / 100) * circumference;
  const { ringClass, textClass } = getUsageClasses(usageRatio);

  const usageSummary = !hasContextLimit
    ? t("common.contextIndicator.inputOutput", {
        input: formatVerbose(inputTokens),
        output: formatVerbose(outputTokens),
      })
    : usageUnavailable
      ? t("common.contextIndicator.contextLimitUsageUnavailable", {
          limit: formatVerbose(contextLimit),
        })
      : t("common.contextIndicator.contextWindowUsage", {
          percentage: contextPercentage,
          used: formatK(total),
          limit: formatK(contextLimit),
        });
  const progressLabel = hasContextLimit
    ? t("common.contextIndicator.contextWindowProgressLabel", {
        percentage: contextPercentage,
        used: formatVerbose(total),
        limit: formatVerbose(contextLimit),
      })
    : usageSummary;
  const provider =
    providerDisplayName ?? t("common.contextIndicator.defaultProvider");
  const ariaLabel = t("common.contextIndicator.contextWindowAriaLabel", {
    summary: usageSummary,
  });

  return (
    <HoverCard.Root openDelay={150} closeDelay={0}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className={cn(
            "relative flex size-11 shrink-0 items-center justify-center rounded-full",
            "bg-background/70 backdrop-blur-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            textClass,
            className,
          )}
          aria-label={ariaLabel}
        >
          <svg
            width="44"
            height="44"
            viewBox="0 0 44 44"
            className="-rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="22"
              cy="22"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              className="text-muted/25"
            />
            {hasContextLimit && (
              <circle
                cx="22"
                cy="22"
                r={radius}
                fill="none"
                strokeWidth="4"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className={cn(
                  "transition-[stroke-dashoffset] duration-300",
                  ringClass,
                )}
              />
            )}
          </svg>
          <span className="absolute font-mono text-[13px] font-medium tabular-nums leading-none">
            {displayValue}
          </span>
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="top"
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">
              {t("common.contextIndicator.contextWindow")}
            </span>
            <span className="font-medium tabular-nums">{usageSummary}</span>
          </div>
          {hasContextLimit && !usageUnavailable && (
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercentage}
              aria-valuetext={progressLabel}
              aria-label={progressLabel}
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300",
                  usageRatio !== null && usageRatio > 1
                    ? "bg-destructive"
                    : usageRatio !== null && usageRatio > 0.8
                      ? "bg-amber-500"
                      : "bg-muted-foreground/60",
                )}
                style={{ width: `${String(progressPercentage)}%` }}
              />
            </div>
          )}
          <p className="mt-3 text-sm leading-5 text-muted-foreground">
            {t("common.contextIndicator.automaticCompaction", { provider })}
          </p>
          <HoverCard.Arrow className="fill-popover" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
