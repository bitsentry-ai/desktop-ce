/**
 * An agent turn as a timeline, in the order things happened, following T3
 * Code (https://github.com/pingdotgg/t3code, MIT): the agent's text and its
 * tool calls interleave while it works; once the turn is done, everything
 * but the answer folds behind "Worked for …".
 */

import type { AgentIteration, ChatMessage, ToolCallCard } from "./types";

type AgentMessage = Extract<ChatMessage, { kind: "agent" }>;

type TurnEntry =
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; card: ToolCallCard };

/** What the timeline renders: single entries, or a run of settled tool calls shown as one summary row. */
export type TurnRow =
  | TurnEntry
  | { kind: "tool-group"; key: string; cards: ToolCallCard[] };

export interface TurnTimeline {
  /** Shown inline: everything while the turn runs, or what is left outside the fold. */
  rows: TurnRow[];
  /** Folded behind "Worked for" once the turn is done; empty when there is nothing to fold. */
  foldedRows: TurnRow[];
  /** The work's duration, for the fold label. */
  workedMs: number | null;
}

/** Sorts last within its iteration: text with no stream timing arrived with the final answer. */
const END_OF_ITERATION = Number.MAX_SAFE_INTEGER;

function timeOf(iso: string | undefined): number {
  if (iso === undefined) return END_OF_ITERATION;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? END_OF_ITERATION : ms;
}

function visibleIterationText(message: AgentMessage, iteration: AgentIteration, isLast: boolean): string {
  if (iteration.text.trim().length > 0) return iteration.text;
  return isLast ? message.finalText ?? "" : "";
}

/**
 * Orders one iteration's text and tool calls by when they started. The text
 * sits at its first streamed chunk; a coding agent CLI streams nothing, so its
 * text comes after the tools it ran. Calls recorded before tool timing existed
 * keep the old order: text, then tools.
 */
function iterationEntries(message: AgentMessage, iteration: AgentIteration, isLast: boolean, tools: Map<string, ToolCallCard>): TurnEntry[] {
  const ordered: Array<{ at: number; order: number; entry: TurnEntry }> = [];
  const text = visibleIterationText(message, iteration, isLast);
  if (text.trim().length > 0) {
    ordered.push({ at: timeOf(iteration.streamDeltas?.[0]?.timestamp), order: 0, entry: { kind: "text", key: `${iteration.id}:text`, text } });
  }
  const seen = new Set<string>();
  for (const toolCallId of iteration.toolCallIds) {
    const card = tools.get(toolCallId);
    if (card === undefined || seen.has(toolCallId)) continue;
    seen.add(toolCallId);
    ordered.push({ at: timeOf(card.startedAt), order: 1, entry: { kind: "tool", key: toolCallId, card } });
  }
  return ordered.sort((left, right) => left.at - right.at || left.order - right.order).map(({ entry }) => entry);
}

/** Consecutive settled tool calls read as one summary row; a running or lone call keeps its own row. */
function groupTurnEntries(entries: TurnEntry[]): TurnRow[] {
  const rows: TurnRow[] = [];
  let run: ToolCallCard[] = [];
  const flush = () => {
    if (run.length === 1) rows.push({ kind: "tool", key: run[0].toolCallId, card: run[0] });
    if (run.length > 1) rows.push({ kind: "tool-group", key: run.map((card) => card.toolCallId).join("+"), cards: run });
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool" && entry.card.state !== "running") {
      run.push(entry.card);
      continue;
    }
    flush();
    rows.push(entry);
  }
  flush();
  return rows;
}

function workedMs(message: AgentMessage): number | null {
  const first = message.iterations[0]?.startedAt;
  const ends = [
    ...message.iterations.map((iteration) => iteration.completedAt),
    ...message.toolCalls.map((card) => card.completedAt),
  ].map(timeOf).filter((ms) => ms !== END_OF_ITERATION);
  if (first === undefined || ends.length === 0) return null;
  const elapsed = Math.max(...ends) - timeOf(first);
  return elapsed >= 0 ? elapsed : null;
}

export function deriveTurnTimeline(message: AgentMessage): TurnTimeline {
  const tools = new Map(message.toolCalls.map((card) => [card.toolCallId, card]));
  const entries = message.iterations.flatMap((iteration, index) =>
    iterationEntries(message, iteration, index === message.iterations.length - 1, tools),
  );
  if (message.iterations.length === 0 && (message.finalText ?? "").trim().length > 0) {
    entries.push({ kind: "text", key: "final", text: message.finalText ?? "" });
  }

  // Like T3 Code, only a finished turn folds, and only when it hides tool work.
  // A failed or stopped turn stays open so the engineer sees what happened.
  const finalIndex = entries.map((entry) => entry.kind).lastIndexOf("text");
  const hasToolWork = entries.some((entry) => entry.kind === "tool");
  if (message.status !== "done" || !hasToolWork || finalIndex === -1) {
    return { rows: groupTurnEntries(entries), foldedRows: [], workedMs: null };
  }

  const answer = entries[finalIndex];
  const folded = entries.filter((_, index) => index !== finalIndex);
  return { rows: [answer], foldedRows: groupTurnEntries(folded), workedMs: workedMs(message) };
}
