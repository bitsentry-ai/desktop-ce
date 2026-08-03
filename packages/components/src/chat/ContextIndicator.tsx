import { cn } from "../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";

interface ContextIndicatorProps {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextLimit?: number;
  usageUnavailable?: boolean;
  className?: string;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${String(Math.round(n / 1_000))}k`;
  return String(n);
}

function formatVerbose(n: number): string {
  return n.toLocaleString();
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

function getUsageClasses(usageRatio: number | null): { ringClass: string; textClass: string } {
  if (usageRatio !== null && usageRatio > 1) {
    return { ringClass: "stroke-destructive", textClass: "text-destructive" };
  }
  if (usageRatio !== null && usageRatio > 0.8) {
    return {
      ringClass: "stroke-amber-500",
      textClass: "text-amber-600 dark:text-amber-400",
    };
  }
  return { ringClass: "stroke-muted-foreground/60", textClass: "text-muted-foreground/70" };
}

function getContextTitle(
  t: ReturnType<typeof useTranslation>["t"],
  inputTokens: number,
  outputTokens: number,
  total: number,
  contextLimit: number | undefined,
  contextTokens: number | undefined,
  usageUnavailable: boolean,
  contextPercentage: number,
): string {
  if (contextLimit === undefined) {
    return t("common.contextIndicator.inputOutput", {
      input: formatVerbose(inputTokens), output: formatVerbose(outputTokens),
    });
  }
  if (usageUnavailable) {
    return t("common.contextIndicator.contextLimitUsageUnavailable", { limit: formatVerbose(contextLimit) });
  }
  const commonValues = {
    total: formatVerbose(total), limit: formatVerbose(contextLimit), percentage: contextPercentage,
    input: formatVerbose(inputTokens), output: formatVerbose(outputTokens),
  };
  return contextTokens === undefined
    ? t("common.contextIndicator.contextWithInputOutput", commonValues)
    : t("common.contextIndicator.contextWithRequest", commonValues);
}

export function ContextIndicator({
  inputTokens,
  outputTokens,
  contextTokens,
  contextLimit,
  usageUnavailable = false,
  className,
}: ContextIndicatorProps) {
  const { t } = useTranslation();
  const requestTotal = inputTokens + outputTokens;
  const total = contextTokens ?? requestTotal;
  if (total === 0 && requestTotal === 0 && contextLimit === undefined) return null;

  const usageRatio = getUsageRatio(total, contextLimit, usageUnavailable);
  const percentage = usageRatio === null ? 0 : Math.min(usageRatio, 1) * 100;
  const displayValue = usageUnavailable && contextLimit !== undefined
    ? "?"
    : usageRatio === null ? formatK(total) : String(Math.round(usageRatio * 100));
  const radius = 14;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset =
    circumference - (percentage / 100) * circumference;

  const { ringClass, textClass } = getUsageClasses(usageRatio);
  const contextPercentage = contextLimit !== undefined && contextLimit > 0
    ? Math.round((total / contextLimit) * 100)
    : 0;

  let progressCircle: React.ReactNode = null;
  if (contextLimit !== undefined) {
    progressCircle = (
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        strokeWidth="4"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        className={cn("transition-[stroke-dashoffset] duration-300", ringClass)}
      />
    );
  }

  const title = getContextTitle(
    t, inputTokens, outputTokens, total, contextLimit, contextTokens,
    usageUnavailable, contextPercentage,
  );

  return (
    <div
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center rounded-full",
        "bg-background/70 backdrop-blur-sm",
        textClass,
        className,
      )}
      title={title}
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
        {progressCircle}
      </svg>
      <span className="absolute font-mono text-[13px] font-medium tabular-nums leading-none">
        {displayValue}
      </span>
    </div>
  );
}
