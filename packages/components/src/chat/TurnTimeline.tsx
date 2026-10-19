/**
 * TurnTimeline — an agent turn as T3 Code shows it
 * (https://github.com/pingdotgg/t3code, MIT): one quiet line per tool call,
 * interleaved with the agent's text in the order things happened, runs of
 * settled calls summarized in one line, and the finished turn's work folded
 * behind "Worked for …".
 */

import { useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Globe,
  ScrollText,
  Search,
  SquarePen,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { parseHostToolError } from "@bitsentry-ce/core";
import { useTranslation } from "@bitsentry-ce/i18n";
import { MarkdownContent } from "../markdown";
import { cn } from "../lib/utils";
import { formatDuration } from "./utils";
import { dominantToolKind, summarizeToolGroup, toolDetail, toolKind, toolLabel, type ToolKind } from "./toolPresentation";
import { deriveTurnTimeline, type TurnRow } from "./turnTimelineRows";
import { CITATION_SOURCE_ATTRIBUTE } from "./citationDom";
import type { ChatMessage, ToolCallCard } from "./types";

type AgentMessage = Extract<ChatMessage, { kind: "agent" }>;

const KIND_ICONS: Record<ToolKind, LucideIcon> = {
  runbook: BookOpen,
  command: Terminal,
  logs: ScrollText,
  request: Globe,
  lookup: Search,
  draft: SquarePen,
  other: Wrench,
};

const rowClassName =
  "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 py-0.5 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function RowLine({ icon, label, trailing }: { icon: ReactNode; label: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-6 min-w-0 select-none items-center gap-1.5 text-sm leading-relaxed">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
        <div className="min-w-0 flex-1 truncate text-muted-foreground">{label}</div>
      </div>
      {trailing}
    </div>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <ChevronRight className={cn("size-3 opacity-70 transition-transform duration-200", expanded && "rotate-90")} />
    </span>
  );
}

function ToolIcon({ kind }: { kind: ToolKind }) {
  const Icon = KIND_ICONS[kind];
  return <Icon className="size-4 shrink-0 stroke-2 text-muted-foreground opacity-70" aria-hidden />;
}

function stringifyInput(input: Record<string, unknown> | undefined): string | null {
  if (input === undefined || Object.keys(input).length === 0) return null;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
}

const detailBlockClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground select-text";

function ToolDetails({ card }: { card: ToolCallCard }) {
  const { t } = useTranslation();
  const input = stringifyInput(card.input);
  const output = card.output?.trim();
  const modelContext = card.modelContext?.trim();
  const failure = card.error !== undefined && card.error.trim().length > 0 ? parseHostToolError(card.error) : undefined;

  return (
    <div
      className="mb-1.5 ml-7 mt-0.5 space-y-2 pb-1"
      onClick={(event) => { event.stopPropagation(); }}
      onPointerDown={(event) => { event.stopPropagation(); }}
    >
      {failure !== undefined && <p className="break-words text-xs text-destructive">{failure.summary}</p>}
      {input !== null && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">{t("common.chat.tools.input")}</p>
          <pre className={detailBlockClassName}>{input}</pre>
        </div>
      )}
      {output !== undefined && output.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">{t("common.chat.tools.output")}</p>
          <pre className={detailBlockClassName}>{output}</pre>
        </div>
      )}
      {failure !== undefined && (failure.structured || failure.raw !== failure.summary) && (
        <details className="space-y-1">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
            {t("common.toolCallCard.viewTechnicalDetails")}
          </summary>
          {failure.issues.length > 0 && (
            <ul className="space-y-1">
              {failure.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`} className="min-w-0">
                  {issue.path.length > 0 && (
                    <span className="break-all font-mono text-[11px] text-muted-foreground">{issue.path}</span>
                  )}
                  <span className="block break-words text-[11px] text-muted-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
          <pre className={detailBlockClassName}>{failure.raw}</pre>
        </details>
      )}
      {modelContext !== undefined && modelContext.length > 0 && (
        <details className="space-y-1">
          <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground">
            {t("common.toolCallCard.modelContextSentToLlm")}
          </summary>
          <pre className={detailBlockClassName}>{modelContext}</pre>
        </details>
      )}
    </div>
  );
}

function ToolRow({ card }: { card: ToolCallCard }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const kind = toolKind(card.toolName);
  const detail = toolDetail(card);
  const failed = card.state === "failed";
  const running = card.state === "running";
  const progress = running ? card.progress?.trim() : undefined;

  return (
    <div className={rowClassName} role="button" tabIndex={0} aria-expanded={expanded}
      onClick={() => { setExpanded((value) => !value); }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
    >
      <RowLine
        icon={failed
          ? <span role="img" aria-label={t("common.chat.tools.failed")}><ToolIcon kind={kind} /></span>
          : <ToolIcon kind={kind} />}
        label={
          <span className={cn("block truncate", running && "live-tool-shine", failed && "text-destructive")}>
            {toolLabel(card, t)}
            {detail !== undefined && <span className="ml-1.5 font-mono text-xs text-muted-foreground/80">{detail}</span>}
          </span>
        }
        trailing={
          <>
            {failed && <X aria-hidden className="size-3 shrink-0 text-destructive/60" />}
            <Chevron expanded={expanded} />
          </>
        }
      />
      {progress !== undefined && progress.length > 0 && (
        <p className="pl-[1.875rem] text-xs text-muted-foreground/80 break-words" aria-live="polite">{progress}</p>
      )}
      {expanded && <ToolDetails card={card} />}
    </div>
  );
}

function ToolGroupRow({ cards }: { cards: ToolCallCard[] }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const failed = cards.some((card) => card.state === "failed");
  const summary = summarizeToolGroup(cards, t);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={failed ? `${summary}, ${t("common.chat.tools.failed")}` : summary}
        onClick={() => { setExpanded((value) => !value); }}
        className={rowClassName}
      >
        <RowLine
          icon={<ToolIcon kind={dominantToolKind(cards)} />}
          label={<span className={cn("block truncate", failed && "text-destructive")}>{summary}</span>}
          trailing={<Chevron expanded={expanded} />}
        />
      </button>
      {expanded && (
        <div className="flex min-w-0 flex-col" aria-label={t("common.chat.tools.toolCalls")}>
          {cards.map((card) => <ToolRow key={card.toolCallId} card={card} />)}
        </div>
      )}
    </div>
  );
}

function TimelineRows({ rows, collapsedJsonLabel }: { rows: TurnRow[]; collapsedJsonLabel?: string }) {
  return (
    <>
      {rows.map((row) => {
        if (row.kind === "text") {
          // The final answer of a message without iterations has no stable id, so it cannot be cited.
          const citationSource = row.key === "final" ? {} : { [CITATION_SOURCE_ATTRIBUTE]: row.key };
          return (
            <div key={row.key} {...citationSource} className="py-1 text-sm leading-relaxed text-foreground">
              <MarkdownContent content={row.text} paragraphizeSoftBreaks collapsedJsonLabel={collapsedJsonLabel} />
            </div>
          );
        }
        if (row.kind === "tool") return <ToolRow key={row.key} card={row.card} />;
        return <ToolGroupRow key={row.key} cards={row.cards} />;
      })}
    </>
  );
}

export function TurnTimeline({
  msg,
  nowMs,
  collapsedJsonLabel,
}: {
  msg: AgentMessage;
  nowMs: number;
  collapsedJsonLabel?: string;
}) {
  const { t } = useTranslation();
  const [foldOpen, setFoldOpen] = useState(false);
  const timeline = deriveTurnTimeline(msg);
  const isWorking = msg.status === "thinking" || msg.status === "streaming";
  const startedAt = msg.iterations[0]?.startedAt;

  let workingRow: ReactNode = null;
  if (isWorking) {
    let label = t("common.incidents.aiIsResponding");
    if (startedAt !== undefined) {
      label = `${t("common.incidents.workingFor")} ${formatDuration(Math.max(0, nowMs - Date.parse(startedAt)))}`;
    }
    workingRow = (
      <div className="border-b border-border/60 pb-2 pt-1">
        <div className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-sm leading-relaxed tabular-nums text-muted-foreground">
          <span className="shrink-0 whitespace-nowrap">{label}</span>
        </div>
      </div>
    );
  }

  let foldRow: ReactNode = null;
  if (timeline.foldedRows.length > 0) {
    const label = timeline.workedMs === null
      ? t("common.chat.tools.worked")
      : t("common.chat.tools.workedFor", { duration: formatDuration(timeline.workedMs) });
    foldRow = (
      <div className="flex items-center gap-1 border-b border-border/60 pb-2 pt-1">
        <button
          type="button"
          aria-expanded={foldOpen}
          onClick={() => { setFoldOpen((value) => !value); }}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed tabular-nums text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          <span>{label}</span>
          {foldOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-0.5">
      {workingRow}
      {foldRow}
      {foldOpen && <TimelineRows rows={timeline.foldedRows} collapsedJsonLabel={collapsedJsonLabel} />}
      <TimelineRows rows={timeline.rows} collapsedJsonLabel={collapsedJsonLabel} />
    </div>
  );
}
