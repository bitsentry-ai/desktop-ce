/**
 * How a tool call reads in the chat timeline: a verb, the argument that
 * matters, and an icon. Groups of settled calls summarize by kind, the way
 * T3 Code (https://github.com/pingdotgg/t3code, MIT) does: "Ran 2 runbooks
 * and queried logs 3 times".
 */

import type { ToolCallCard } from "./types";

export type ToolKind = "runbook" | "command" | "logs" | "request" | "lookup" | "draft" | "other";

type Translate = (key: string, values?: Record<string, unknown>) => string;

const K = "common.chat.tools";

/** Coding agent CLIs call our host tools through MCP, which prefixes the server name. */
export function baseToolName(toolName: string): string {
  return toolName.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "").replace(/^bitsentry[.:]/, "");
}

export function toolKind(toolName: string): ToolKind {
  const name = baseToolName(toolName);
  if (name === "execute_runbook") return "runbook";
  if (name === "execute_shell_command") return "command";
  if (name === "ssh_journal_query" || name === "list_log_sources" || name === "get_checkpoint") return "logs";
  if (name === "execute_http_request") return "request";
  if (/^(list|get|read|search)_/.test(name)) return "lookup";
  if (/^(propose|draft)_/.test(name) || name === "ticket_operation" || name === "request_customer_report_input") return "draft";
  return "other";
}

function readString(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function humanizeToolName(name: string): string {
  return name.replace(/^(list|get|read|search|propose|draft)_/, "").replace(/_/g, " ");
}

/** The argument worth showing next to the verb, if any. */
export function toolDetail(card: ToolCallCard): string | undefined {
  const name = baseToolName(card.toolName);
  const input = card.input;
  switch (toolKind(card.toolName)) {
    case "runbook":
      return readString(input, "runbookTitle", "title", "runbookId");
    case "command":
      return readString(input, "command");
    case "logs": {
      const target = [readString(input, "host", "hostname", "target"), readString(input, "unit", "service", "sourceId")]
        .filter((part): part is string => part !== undefined)
        .join(" · ");
      return target.length > 0 ? target : undefined;
    }
    case "request": {
      const url = readString(input, "url");
      if (url === undefined) return undefined;
      return [readString(input, "method")?.toUpperCase(), url].filter(Boolean).join(" ");
    }
    case "lookup":
    case "draft":
      return readString(input, "query") ?? humanizeToolName(name);
    case "other":
      return name;
  }
}

export function toolLabel(card: ToolCallCard, t: Translate): string {
  const kind = toolKind(card.toolName);
  return t(`${K}.${kind}.${card.state === "running" ? "running" : "done"}`);
}

function rankToolKinds(cards: ToolCallCard[]): Array<[ToolKind, number]> {
  const counts = new Map<ToolKind, number>();
  for (const card of cards) {
    const kind = toolKind(card.toolName);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/** The kind most of the calls share, for a group's icon. */
export function dominantToolKind(cards: ToolCallCard[]): ToolKind {
  return rankToolKinds(cards)[0]?.[0] ?? "other";
}

/** "Ran 2 runbooks and queried logs 3 times": the two most frequent kinds, then a count of the rest. */
export function summarizeToolGroup(cards: ToolCallCard[], t: Translate): string {
  const ranked = rankToolKinds(cards);
  const labels = ranked.map(([kind, count]) => t(`${K}.${kind}.group`, { count }));
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return t(`${K}.joinTwo`, { first: labels[0], second: labels[1] });
  const rest = ranked.slice(2).reduce((total, [, count]) => total + count, 0);
  return t(`${K}.joinMore`, { first: labels[0], second: labels[1], count: rest });
}
