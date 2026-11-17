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
    }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string };

// Only the first few lines that open a JSON value are tried, so a long log
// with many `{` lines costs a bounded number of parse attempts.
const MAX_EMBEDDED_JSON_CANDIDATES = 3;
const PREVIEW_MAX_LENGTH = 400;

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
  if (typeof parsed !== "string" || !opensJsonContainer(parsed.trim())) return null;

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
function findTrailingJson(text: string): { lead: string; value: object } | null {
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
    if (["-", "*", "+", ">"].includes(firstCharacter) && value[1] === " ") return true;
    if (value.startsWith("|") && value.lastIndexOf("|") > 0) return true;

    let digitCount = 0;
    while (value[digitCount] >= "0" && value[digitCount] <= "9") digitCount += 1;
    return digitCount > 0 && value[digitCount] === "." && value[digitCount + 1] === " ";
  });
}

function hasDelimitedText(value: string, delimiter: string): boolean {
  const first = value.indexOf(delimiter);
  return (
    first >= 0 &&
    value.indexOf(delimiter, first + delimiter.length) > first + delimiter.length
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

/**
 * A short plain-text excerpt for the Summary column. JSON with a lead sentence
 * previews the sentence; everything else previews its opening characters.
 */
export function runOutputPreview(value: string): string {
  const format = detectRunOutputFormat(value);
  switch (format.kind) {
    case "empty":
      return "";
    case "json":
      return (format.lead.length > 0 ? format.lead : format.display).slice(
        0,
        PREVIEW_MAX_LENGTH,
      );
    case "markdown":
    case "text":
      return format.text.slice(0, PREVIEW_MAX_LENGTH);
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
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlineCount += 1;
    if (newlineCount === maxLines) cutAt = index;
  }
  const totalLines = newlineCount + 1;
  if (cutAt === -1) {
    return { text, totalLines, truncated: false };
  }
  return { text: text.slice(0, cutAt), totalLines, truncated: true };
}
