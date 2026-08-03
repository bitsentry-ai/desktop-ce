/**
 * Display-only formatters for captured runbook data.
 *
 * Steps routinely capture multi-line text (external source query results, shell
 * output, stack traces). When that text sits inside an object we serialize for
 * display, `JSON.stringify` escapes its newlines, so the results panel renders
 * one long line full of literal `\n` instead of readable output.
 *
 * Everything here formats for rendering only. Stored step values, execution
 * payloads, and anything editable are untouched.
 */

const COMPACT_VALUE_MAX_LENGTH = 40;

function whitespaceForEscapeMarker(marker: string): string | null {
  switch (marker) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return null;
  }
}

/**
 * Expands the whitespace escapes `JSON.stringify` emits back into real
 * whitespace.
 *
 * Only escapes that `JSON.stringify` itself introduced are expanded. An even
 * run of backslashes means the source string held literal backslashes —
 * `"line\\nbreak"` serializes to `"line\\\\nbreak"` — so those are left exactly
 * as they are. Apply this to freshly serialized JSON only, never to a string
 * that arrived from elsewhere, since an author-written `\n` is real content.
 */
export function expandJsonWhitespaceEscapes(json: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < json.length) {
    if (json[cursor] !== "\\") {
      result += json[cursor];
      cursor += 1;
      continue;
    }

    let runEnd = cursor;
    while (json[runEnd] === "\\") runEnd += 1;
    const marker = json[runEnd];
    const whitespace = marker === undefined ? null : whitespaceForEscapeMarker(marker);
    const backslashCount = runEnd - cursor;
    if (whitespace === null || backslashCount % 2 === 0) {
      result += json.slice(cursor, runEnd + (marker === undefined ? 0 : 1));
    } else {
      result += `${json.slice(cursor, runEnd - 1)}${whitespace}`;
    }
    cursor = marker === undefined ? runEnd : runEnd + 1;
  }
  return result;
}

/**
 * Drops blank lines so a captured block reads as a dense property list.
 *
 * Providers format their text for a full-width output pane — the Sentry
 * formatter joins its header with `"\n\n"`, and its empty separator entry turns
 * into three blank lines — which is roughly a quarter of the height once
 * expanded into a narrow results cell. Every line here is already self-labelled
 * (`Source:`, `Level / Status:`, `1.`), so the separators cost height without
 * adding structure. `JSON.stringify` never emits consecutive newlines of its
 * own, so every run this touches came from string content.
 */
function collapseBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, "\n").trim();
}

function formatJsonValue(value: object): string {
  let compact: string;
  try {
    compact = JSON.stringify(value);
  } catch {
    return String(value);
  }

  // Short values stay on one line, but only when nothing needs expanding —
  // otherwise the same payload would show `\n` here and real breaks below.
  const expandedCompact = expandJsonWhitespaceEscapes(compact);
  if (compact.length <= COMPACT_VALUE_MAX_LENGTH && expandedCompact === compact) {
    return compact;
  }

  try {
    return collapseBlankLines(
      expandJsonWhitespaceEscapes(JSON.stringify(value, null, 2)),
    );
  } catch {
    return expandedCompact;
  }
}

/**
 * Formats one structured-output value for the results table.
 *
 * Plain strings are returned verbatim — they are already real text, and a
 * backslash-n inside one is content rather than an escape we created.
 */
export function formatStructuredValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") {
          return formatJsonValue(parsed);
        }
      } catch {
        return value;
      }
    }
    return value;
  }

  if (value === null || typeof value !== "object") {
    return String(value);
  }

  return formatJsonValue(value);
}

/**
 * Pretty-prints a value as a JSON block for display. Returns an empty string
 * when there is nothing serializable so callers can show their own empty state.
 */
export function formatJsonBlockForDisplay(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  try {
    const json = JSON.stringify(value, null, 2);
    if (typeof json !== "string") {
      return "";
    }

    return collapseBlankLines(expandJsonWhitespaceEscapes(json));
  } catch {
    return "";
  }
}
