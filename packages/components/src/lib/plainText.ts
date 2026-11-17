const INLINE_MARKERS = ["**", "__", "~~", "`"];

function isTableRule(line: string): boolean {
  if (!line.includes("---")) return false;
  for (const char of line) {
    if (char !== "|" && char !== "-" && char !== ":" && char !== " ") return false;
  }
  return true;
}

function stripLinePrefix(line: string): string {
  let rest = line;
  if (rest.startsWith("#")) {
    let index = 0;
    while (index < rest.length && rest[index] === "#") index += 1;
    rest = rest.slice(index);
  }
  if (rest.startsWith(">")) rest = rest.slice(1);
  rest = rest.trimStart();
  if (rest.startsWith("- ") || rest.startsWith("* ") || rest.startsWith("+ ")) {
    return rest.slice(2);
  }
  let digits = 0;
  while (digits < rest.length && rest[digits] >= "0" && rest[digits] <= "9") digits += 1;
  if (digits > 0 && (rest[digits] === "." || rest[digits] === ")") && rest[digits + 1] === " ") {
    return rest.slice(digits + 2);
  }
  return rest;
}

function keepLinkText(line: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("[", cursor);
    const middle = open === -1 ? -1 : line.indexOf("](", open);
    const close = middle === -1 ? -1 : line.indexOf(")", middle);
    if (open === -1 || middle === -1 || close === -1) {
      result += line.slice(cursor);
      break;
    }
    const start = open > 0 && line[open - 1] === "!" ? open - 1 : open;
    result += line.slice(cursor, start) + line.slice(open + 1, middle);
    cursor = close + 1;
  }
  return result;
}

function stripInline(line: string): string {
  let text = keepLinkText(line);
  for (const marker of INLINE_MARKERS) text = text.split(marker).join("");
  if (text.includes("|")) {
    text = text
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
      .join(" · ");
  }
  return text;
}

/**
 * Turns a markdown snippet into one line of readable text for list previews:
 * drops emphasis markers, code ticks, headings, list bullets, fences and table
 * rules, and keeps the text of links.
 */
export function markdownToPlainText(value: string): string {
  const parts: string[] = [];
  let inFence = false;
  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || isTableRule(line)) continue;
    const text = stripInline(stripLinePrefix(line)).trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export type StatusTone = "neutral" | "running" | "success" | "danger";

/** Shared pill classes for agent/run states, built on the theme status tokens. */
export const statusToneClass: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground before:bg-muted-foreground/60",
  running:
    "bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))] before:bg-[hsl(var(--warning))] before:animate-pulse",
  success: "bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))] before:bg-[hsl(var(--success))]",
  danger: "bg-[hsl(var(--destructive)/0.1)] text-[hsl(var(--destructive))] before:bg-[hsl(var(--destructive))]",
};

export const statusPillBaseClass =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium leading-4 before:size-1.5 before:shrink-0 before:rounded-full before:content-['']";
