/**
 * Classifies captured runbook output for the Results view.
 *
 * Steps return free text, but much of it is JSON: a bare object, a JSON value
 * serialized into a string, or a one-line summary followed by the payload
 * ("Fetched 10 findings.\n\n{ ... }"). Rendered as prose, that JSON collapses
 * into one wrapped paragraph full of escaped `\n` and stray Markdown, so it is
 * detected here and pretty-printed instead.
 *
 * Display only: the stored output is never rewritten.
 */

import { expandJsonWhitespaceEscapes } from "../lib/jsonDisplay";

export type RunOutputFormat =
  | { kind: "empty" }
  | {
      kind: "json";
      /** Prose that came before the JSON payload, if any. */
      lead: string;
      /** Pretty-printed JSON with string escapes expanded into real whitespace. */
      display: string;
      /** Valid pretty-printed JSON (plus the lead) for the clipboard. */
      copyText: string;
      /** The parsed payload. */
      value: unknown;
    }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string };

// Only the first few lines that open a JSON value are tried, so a long log
// with many `{` lines costs a bounded number of parse attempts.
const MAX_EMBEDDED_JSON_CANDIDATES = 3;

function isJsonContainer(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function opensJsonContainer(text: string): boolean {
  return text.startsWith("{") || text.startsWith("[");
}

/**
 * Parses `text` as a JSON object or array. A JSON string literal whose content
 * is itself an object or array (JSON serialized twice) is unwrapped once.
 */
export function parseJsonContainer(text: string): object | null {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (isJsonContainer(parsed)) return parsed;
  if (typeof parsed !== "string" || !opensJsonContainer(parsed.trim()))
    return null;

  try {
    const inner: unknown = JSON.parse(parsed);
    return isJsonContainer(inner) ? inner : null;
  } catch {
    return null;
  }
}

/**
 * Finds a JSON object or array that starts at the beginning of a line and runs
 * to the end of the text, returning the prose before it.
 */
function findTrailingJson(
  text: string,
): { lead: string; value: object } | null {
  let attempts = 0;
  let lineStart = 0;
  while (lineStart < text.length && attempts < MAX_EMBEDDED_JSON_CANDIDATES) {
    const lineEnd = text.indexOf("\n", lineStart);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    // Line 0 is the whole text, which the caller has already tried.
    if (lineStart > 0 && opensJsonContainer(line.trimStart())) {
      attempts += 1;
      const value = parseJsonContainer(text.slice(lineStart));
      if (value !== null) {
        return { lead: text.slice(0, lineStart).trim(), value };
      }
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return null;
}

function hasMarkdownStructureLine(text: string): boolean {
  return text.split("\n").some((line) => {
    const value = line.trimStart();
    const firstCharacter = value[0] ?? "";
    if (firstCharacter === "#") {
      const headingLength = value.indexOf(" ");
      return headingLength > 0 && headingLength <= 6;
    }
    if (["-", "*", "+", ">"].includes(firstCharacter) && value[1] === " ")
      return true;
    if (value.startsWith("|") && value.lastIndexOf("|") > 0) return true;

    let digitCount = 0;
    while (value[digitCount] >= "0" && value[digitCount] <= "9")
      digitCount += 1;
    return (
      digitCount > 0 &&
      value[digitCount] === "." &&
      value[digitCount + 1] === " "
    );
  });
}

function hasDelimitedText(value: string, delimiter: string): boolean {
  const first = value.indexOf(delimiter);
  return (
    first >= 0 &&
    value.indexOf(delimiter, first + delimiter.length) >
      first + delimiter.length
  );
}

function hasMarkdownLink(value: string): boolean {
  const labelStart = value.indexOf("[");
  const labelEnd = value.indexOf("](", labelStart + 1);
  const urlEnd = value.indexOf(")", labelEnd + 2);
  return labelStart >= 0 && labelEnd > labelStart + 1 && urlEnd > labelEnd + 2;
}

export function looksLikeMarkdown(value: string): boolean {
  const text = value.trim();
  if (text.length === 0 || opensJsonContainer(text)) return false;

  return (
    hasMarkdownStructureLine(text) ||
    hasDelimitedText(text, "**") ||
    hasDelimitedText(text, "`") ||
    hasMarkdownLink(text) ||
    text.includes("```")
  );
}

function jsonFormat(lead: string, value: object): RunOutputFormat {
  const pretty = JSON.stringify(value, null, 2);
  return {
    kind: "json",
    lead,
    display: expandJsonWhitespaceEscapes(pretty),
    copyText: lead.length > 0 ? `${lead}\n\n${pretty}` : pretty,
    value,
  };
}

export function detectRunOutputFormat(value: string): RunOutputFormat {
  const text = value.trim();
  if (text.length === 0) return { kind: "empty" };

  const whole = parseJsonContainer(text);
  if (whole !== null) return jsonFormat("", whole);

  const trailing = findTrailingJson(text);
  if (trailing !== null) return jsonFormat(trailing.lead, trailing.value);

  if (looksLikeMarkdown(text)) return { kind: "markdown", text };
  return { kind: "text", text };
}

/**
 * Serializes a captured value (step input, parameters) so the output block can
 * detect and pretty-print it. Returns "" when there is nothing to show.
 */
export function stringifyForOutput(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export interface RunOutputPreview {
  /** Prose before a JSON payload; empty otherwise. */
  lead: string;
  /** The payload as it reads in the Output column, capped at `maxLines`. */
  body: string;
  json: boolean;
}

/**
 * The Summary column's view of an output: the same formatted text the Output
 * column shows (pretty JSON, or the text itself), capped at `maxLines` lines so
 * expanding the preview never lays out an unbounded payload.
 */
export function runOutputPreview(
  value: string,
  maxLines: number,
): RunOutputPreview | null {
  const format = detectRunOutputFormat(value);
  switch (format.kind) {
    case "empty":
      return null;
    case "json":
      return {
        lead: format.lead,
        body: truncateLines(format.display, maxLines).text,
        json: true,
      };
    case "markdown":
    case "text":
      return {
        lead: "",
        body: truncateLines(format.text, maxLines).text,
        json: false,
      };
  }
}

export interface TruncatedLines {
  text: string;
  totalLines: number;
  truncated: boolean;
}

/** Keeps the first `maxLines` lines of `text`. */
export function truncateLines(text: string, maxLines: number): TruncatedLines {
  let newlineCount = 0;
  let cutAt = -1;
  for (
    let index = text.indexOf("\n");
    index !== -1;
    index = text.indexOf("\n", index + 1)
  ) {
    newlineCount += 1;
    if (newlineCount === maxLines) cutAt = index;
  }
  const totalLines = newlineCount + 1;
  if (cutAt === -1) {
    return { text, totalLines, truncated: false };
  }
  return { text: text.slice(0, cutAt), totalLines, truncated: true };
}

export interface JsonSummaryField {
  key: string;
  /** The value on one line: strings as written, anything else as compact JSON. */
  value: string;
}

export interface JsonSummary {
  /** A one-line outcome such as "10 of 103 findings returned", when the payload has a list (and a total). */
  headline: { shown: number; total: number | null; noun: string } | null;
  /** The fields worth reading, without paging and transport fields. */
  fields: JsonSummaryField[];
  /** Paging and transport fields (offset, hasMore, cursors…), kept for a Details disclosure. */
  details: JsonSummaryField[];
  /** Number of readable top-level fields, including the ones not listed. */
  total: number;
}

/** Fields that describe the request or paging rather than the result. */
const TRANSPORT_FIELDS = new Set([
  "offset", "limit", "cursor", "nextcursor", "next_cursor", "hasmore", "has_more", "page", "pagesize", "page_size",
  "indexpattern", "index_pattern", "took", "timed_out", "scroll_id", "nextpagetoken", "next_page_token",
]);
const TOTAL_FIELDS = ["total", "totalcount", "total_count", "totalhits", "total_hits", "count"];

function isTransportField(key: string): boolean {
  return TRANSPORT_FIELDS.has(key.toLowerCase());
}

function outcomeHeadline(entries: [string, unknown][]): JsonSummary["headline"] {
  const list = entries.find(([, value]) => Array.isArray(value));
  if (list === undefined) return null;
  const totalEntry = entries.find(
    ([key, value]) => TOTAL_FIELDS.includes(key.toLowerCase()) && typeof value === "number",
  );
  const shown = (list[1] as unknown[]).length;
  return { shown, total: totalEntry === undefined ? null : (totalEntry[1] as number), noun: list[0] };
}

/** One line per field: strings as written, scalars as JSON, and nested values by their size ("3 fields", "5 items"). */
function summaryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length === 1 ? "1 item" : `${String(value.length)} items`;
  if (value !== null && typeof value === "object") {
    const count = Object.keys(value).length;
    return count === 1 ? "1 field" : `${String(count)} fields`;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * The top-level fields of a JSON object output, for reading at a glance instead of scanning braces. Null when the
 * output is not a JSON object.
 */
export function jsonSummary(value: string, maxFields: number): JsonSummary | null {
  const format = detectRunOutputFormat(value);
  if (format.kind !== "json") return null;
  const parsed = format.value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  const readable = entries.filter(([key]) => !isTransportField(key));
  const toField = ([key, field]: [string, unknown]): JsonSummaryField => ({ key, value: summaryValue(field) });
  return {
    headline: outcomeHeadline(entries),
    fields: readable.slice(0, maxFields).map(toField),
    details: entries.filter(([key]) => isTransportField(key)).map(toField),
    total: readable.length,
  };
}
