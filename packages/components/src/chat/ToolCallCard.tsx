import { parseHostToolError } from "@bitsentry-ce/core";
import type { ToolCallCard } from "./types";
import { cn } from "../lib/utils";
import { useTranslation } from "@bitsentry-ce/i18n";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useDisclosure } from "./disclosureStore";

export function ToolCard({ card, messageId }: { card: ToolCallCard; messageId: string }) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useDisclosure(`${messageId}:${card.toolCallId}:details`, false);
  const [contextOpen, setContextOpen] = useDisclosure(`${messageId}:${card.toolCallId}:context`, false);
  let dot = "bg-destructive";
  let label = t("common.incidents.toolStateFailed");
  if (card.state === "running") {
    dot = "bg-amber-400 animate-pulse";
    label = "";
  }
  if (card.state === "done") {
    dot = "bg-emerald-400";
    label = t("common.incidents.toolStateDone");
  }
  const modelContext = card.modelContext?.trim();
  const progressText = card.progress?.trim() ?? "";
  const progress =
    card.state === "running" && progressText.length > 0
      ? progressText
      : undefined;
  // Host tools fail with a JSON payload aimed at the model. Show the sentence
  // and keep the codes and field paths behind the details disclosure.
  const failure =
    card.error !== undefined && card.error.trim().length > 0
      ? parseHostToolError(card.error)
      : undefined;
  const hasFailureDetails =
    failure !== undefined && (failure.structured || failure.summary !== failure.raw);
  let containerClassName = "flex w-fit max-w-xs items-center gap-2";
  if (
    (modelContext !== undefined && modelContext.length > 0) ||
    failure !== undefined ||
    progress !== undefined
  ) {
    containerClassName = "w-full max-w-full space-y-2";
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs",
        containerClassName,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-1.5 rounded-full shrink-0", dot)} />
        <span className="font-mono font-medium truncate">{card.toolName}</span>
        {label.length > 0 && (
          <span className="text-muted-foreground shrink-0">{label}</span>
        )}
      </div>
      {progress !== undefined && (
        <p className="break-words text-muted-foreground" aria-live="polite">
          {progress}
        </p>
      )}
      {failure !== undefined && (
        <div className="min-w-0 space-y-1.5">
          <p className="break-words text-destructive">{failure.summary}</p>
          {hasFailureDetails && (
            <details
              className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
              open={detailsOpen}
              onToggle={(e) => { setDetailsOpen(e.currentTarget.open); }}
            >
              <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
                {t("common.toolCallCard.viewTechnicalDetails")}
              </summary>
              {failure.issues.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {failure.issues.map((issue) => (
                    <li key={`${issue.path}:${issue.message}`} className="min-w-0">
                      {issue.path.length > 0 && (
                        <span className="font-mono text-[11px] text-muted-foreground break-all">
                          {issue.path}
                        </span>
                      )}
                      <span className="block break-words text-[11px] text-muted-foreground">
                        {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {failure.raw}
              </pre>
            </details>
          )}
        </div>
      )}
      {modelContext !== undefined && modelContext.length > 0 && (
        <details
          className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5"
          open={contextOpen}
          onToggle={(e) => { setContextOpen(e.currentTarget.open); }}
        >
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
            {t("common.toolCallCard.modelContextSentToLlm")}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {modelContext}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * Collapsible work log group for tool calls.
 * Shows a header that toggles visibility.
 */
export function WorkLogGroup({
  disclosureKey,
  toolCalls,
  children,
}: {
  /** Stable id of the group, e.g. `${messageId}:${iterationId}:group`. */
  disclosureKey: string;
  toolCalls: ToolCallCard[];
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useDisclosure(disclosureKey, true);

  if (toolCalls.length === 0) return null;

  const runningCount = toolCalls.filter((tc) => tc.state === "running").length;
  const doneCount = toolCalls.filter((tc) => tc.state === "done").length;
  const failedCount = toolCalls.filter((tc) => tc.state === "failed").length;
  let toggleIcon = <ChevronRight size={14} />;
  if (isExpanded) {
    toggleIcon = <ChevronDown size={14} />;
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => { setIsExpanded(!isExpanded); }}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {toggleIcon}
        <span>{t("common.incidents.toolCalls", { count: toolCalls.length })}</span>
        {(runningCount > 0 || doneCount > 0 || failedCount > 0) && (
          <span className="ml-auto flex items-center gap-2">
            {runningCount > 0 && (
              <span className="flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
                {runningCount}
              </span>
            )}
            {doneCount > 0 && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {doneCount}
              </span>
            )}
            {failedCount > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <span className="size-1.5 rounded-full bg-destructive" />
                {failedCount}
              </span>
            )}
          </span>
        )}
      </button>
      {isExpanded && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}
