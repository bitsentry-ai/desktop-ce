/**
 * TurnTimeline — an agent turn as T3 Code shows it
 * (https://github.com/pingdotgg/t3code, MIT): one quiet line per tool call,
 * interleaved with the agent's text in the order things happened, runs of
 * settled calls summarized in one line, and the finished turn's work folded
 * behind "Worked for …".
 */

import { use, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Globe,
  ScrollText,
  Search,
  Square,
  SquarePen,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { parseHostToolError } from "@bitsentry-ce/core/shared/host-tool-error";
import { useTranslation } from "@bitsentry-ce/i18n";
import { MarkdownContent } from "../markdown";
import { cn } from "../lib/utils";
import { formatDuration } from "./utils";
import { dominantToolKind, summarizeToolGroup, toolDetail, toolKind, toolLabel, type ToolKind } from "./toolPresentation";
import { deriveTurnTimeline, isTurnStalled, lastTurnActivityMs, type TurnRow } from "./turnTimelineRows";
import { TurnStopContext } from "./turnStop";
import { useDisclosure } from "./disclosureStore";
import { CITATION_SOURCE_ATTRIBUTE } from "./citationDom";
import type { ChatMessage, ToolCallCard } from "./types";
import { renderJsonEvidence } from "./JsonEvidenceBlock";
import { StructuredValue } from "../runbook/StructuredValue";
import { detectRunOutputFormat } from "../runbook/runOutputFormat";

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
    <div className="flex min-h-6 min-w-0 select-none items-center gap-1.5 text-sm leading-[22px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex size-6 shrink-0 items-center justify-center">{icon}</span>
        <div className="min-w-0 flex-1 truncate font-medium text-muted-foreground">{label}</div>
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


const detailBlockClassName =
  "max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-xs leading-relaxed text-muted-foreground select-text";

/** A tool's output: JSON reads as labelled rows or a table; anything else stays as the text the tool returned. */
function ToolOutput({ output }: { output: string }) {
  const format = detectRunOutputFormat(output);
  if (format.kind !== "json") return <pre className={detailBlockClassName}>{output}</pre>;
  return (
    <div className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2">
      <StructuredValue value={format.value} />
    </div>
  );
}

function ToolDetails({ card, messageId }: { card: ToolCallCard; messageId: string }) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useDisclosure(`${messageId}:${card.toolCallId}:details`, false);
  const [contextOpen, setContextOpen] = useDisclosure(`${messageId}:${card.toolCallId}:context`, false);
  const input = card.input !== undefined && Object.keys(card.input).length > 0 ? card.input : null;
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
          <p className="text-xs font-medium text-muted-foreground">{t("common.chat.tools.input")}</p>
          <div className="max-h-64 overflow-auto rounded-md bg-muted/50 p-2">
            <StructuredValue value={input} />
          </div>
        </div>
      )}
      {output !== undefined && output.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t("common.chat.tools.output")}</p>
          <ToolOutput output={output} />
        </div>
      )}
      {failure !== undefined && (failure.structured || failure.raw !== failure.summary) && (
        <details className="space-y-1" open={detailsOpen} onToggle={(event) => { setDetailsOpen(event.currentTarget.open); }}>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            {t("common.toolCallCard.viewTechnicalDetails")}
          </summary>
          {failure.issues.length > 0 && (
            <ul className="space-y-1">
              {failure.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`} className="min-w-0">
                  {issue.path.length > 0 && (
                    <span className="break-all font-mono text-xs text-muted-foreground">{issue.path}</span>
                  )}
                  <span className="block break-words text-xs text-muted-foreground">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
          <pre className={detailBlockClassName}>{failure.raw}</pre>
        </details>
      )}
      {modelContext !== undefined && modelContext.length > 0 && (
        <details className="space-y-1" open={contextOpen} onToggle={(event) => { setContextOpen(event.currentTarget.open); }}>
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground">
            {t("common.toolCallCard.modelContextSentToLlm")}
          </summary>
          <pre className={detailBlockClassName}>{modelContext}</pre>
        </details>
      )}
    </div>
  );
}

function ToolRow({ card, messageId }: { card: ToolCallCard; messageId: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useDisclosure(`${messageId}:${card.toolCallId}:row`, false);
  const kind = toolKind(card.toolName);
  const detail = toolDetail(card);
  const failed = card.state === "failed";
  const running = card.state === "running";
  const progress = running ? card.progress?.trim() : undefined;

  return (
    <div className={rowClassName} role="button" tabIndex={0} aria-expanded={expanded}
      onClick={() => { setExpanded(!expanded); }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setExpanded(!expanded);
      }}
    >
      <RowLine
        icon={failed
          ? <span role="img" aria-label={t("common.chat.tools.failed")}><ToolIcon kind={kind} /></span>
          : <ToolIcon kind={kind} />}
        label={
          <span className={cn("block truncate", running && "live-tool-shine", failed && "text-destructive")}>
            {toolLabel(card, t)}
            {detail !== undefined && <span className="ml-1.5 font-mono text-xs font-normal text-muted-foreground">{detail}</span>}
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
        <p className="pl-[1.875rem] text-xs text-muted-foreground break-words" aria-live="polite">{progress}</p>
      )}
      {expanded && <ToolDetails card={card} messageId={messageId} />}
    </div>
  );
}

function ToolGroupRow({ cards, messageId, groupKey }: { cards: ToolCallCard[]; messageId: string; groupKey: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useDisclosure(`${messageId}:${groupKey}:group`, false);
  const failed = cards.some((card) => card.state === "failed");
  const summary = summarizeToolGroup(cards, t);

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={failed ? `${summary}, ${t("common.chat.tools.failed")}` : summary}
        onClick={() => { setExpanded(!expanded); }}
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
          {cards.map((card) => <ToolRow key={card.toolCallId} card={card} messageId={messageId} />)}
        </div>
      )}
    </div>
  );
}

/** Replies are read at length: 15px with a 24px line, a step above the 14px interface text around them. */
const REPLY_PROSE_CLASS = "text-[15px] leading-6";

function TimelineRows({ rows, messageId, collapsedJsonLabel, streaming = false }: { rows: TurnRow[]; messageId: string; collapsedJsonLabel?: string; streaming?: boolean }) {
  return (
    <>
      {rows.map((row, index) => {
        if (row.kind === "text") {
          // The answer of an unsaved message without iterations has no stable id, so it cannot be cited.
          const citationSource = row.key === "final" ? {} : { [CITATION_SOURCE_ATTRIBUTE]: row.key };
          return (
            <div key={row.key} {...citationSource} className="py-1 text-sm leading-[22px] text-foreground [&_.chat-markdown]:leading-[22px]">
              <MarkdownContent content={row.text} className={REPLY_PROSE_CLASS} paragraphizeSoftBreaks collapsedJsonLabel={collapsedJsonLabel} renderJsonBlock={renderJsonEvidence} streaming={streaming && index === rows.length - 1} />
            </div>
          );
        }
        if (row.kind === "tool") return <ToolRow key={row.key} card={row.card} messageId={messageId} />;
        return <ToolGroupRow key={row.key} cards={row.cards} messageId={messageId} groupKey={row.key} />;
      })}
    </>
  );
}

/** Offers the host's stop for this thread; only a stalled turn mounts it, so streaming never reads the context. */
function StopTurnButton() {
  const { t } = useTranslation();
  const stop = use(TurnStopContext);
  if (stop === null) return null;
  return (
    <button
      type="button"
      onClick={stop}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
    >
      <Square aria-hidden className="size-3" />
      {t("common.incidentDetail.stop")}
    </button>
  );
}

/**
 * The running turn's one label: how long it has worked, or, once nothing new arrived for half an hour, that this turn
 * may have stalled. A stalled turn reads as a warning about the turn, not as work in progress: a compact neutral panel
 * with how long nothing has happened, how long the reply has run, and the host's stop, with no spinner. The header
 * keeps the incident's own status and adds a "Latest reply stalled" badge beside it.
 */
function WorkingRow({ msg, startedAt, nowMs }: { msg: AgentMessage; startedAt: string | undefined; nowMs: number }) {
  const { t } = useTranslation();
  const startedMs = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return (
      <div className="border-b border-border/60 pb-2 pt-1">
        <div className="flex min-h-6 items-center px-1 text-sm leading-[22px] text-muted-foreground">{t("common.incidents.aiIsResponding")}</div>
      </div>
    );
  }
  const duration = formatDuration(Math.max(0, nowMs - startedMs));
  if (!isTurnStalled(msg, nowMs)) {
    return (
      <div className="border-b border-border/60 pb-2 pt-1">
        <div className="flex min-h-6 min-w-0 items-center px-1 text-sm leading-[22px] tabular-nums">
          <span className="whitespace-nowrap text-muted-foreground">{`${t("common.incidents.workingFor")} ${duration}`}</span>
        </div>
      </div>
    );
  }
  const inactive = formatDuration(Math.max(0, nowMs - (lastTurnActivityMs(msg) ?? startedMs)));
  return (
    <div className="pb-2 pt-1">
      <div
        role="status"
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 p-3 tabular-nums"
      >
        <TriangleAlert aria-hidden className="size-4 shrink-0 self-start text-[hsl(var(--warning-text))] max-sm:mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-5 text-[hsl(var(--warning-text))]">{t("common.incidentDetail.replyStalled")}</p>
          <p className="text-xs leading-[18px] text-muted-foreground">
            {t("common.incidentDetail.stalledDetail", { inactive, duration })}
          </p>
        </div>
        <StopTurnButton />
      </div>
    </div>
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
  // Keys this message's disclosures, so they stay open when the virtualized row remounts.
  const messageId = msg.id ?? "";
  const [foldOpen, setFoldOpen] = useDisclosure(`${messageId}:worked`, false);
  const timeline = deriveTurnTimeline(msg);
  const isWorking = msg.status === "thinking" || msg.status === "streaming";
  const startedAt = msg.iterations[0]?.startedAt;

  const workingRow = isWorking ? <WorkingRow msg={msg} startedAt={startedAt} nowMs={nowMs} /> : null;

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
          onClick={() => { setFoldOpen(!foldOpen); }}
          className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-[22px] tabular-nums text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
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
      {foldOpen && <TimelineRows rows={timeline.foldedRows} messageId={messageId} collapsedJsonLabel={collapsedJsonLabel} />}
      <TimelineRows rows={timeline.rows} messageId={messageId} collapsedJsonLabel={collapsedJsonLabel} streaming={isWorking} />
    </div>
  );
}
