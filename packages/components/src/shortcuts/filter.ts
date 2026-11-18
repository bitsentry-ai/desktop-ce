import { scoreRunbookMatch } from "@bitsentry-ce/core/shared/runbook-match";

/**
 * Palette search. It scores with the same matcher the agent tools use to resolve a runbook, so a person typing in the
 * palette and an agent naming a runbook find the same things: title first (exact, prefix, word start, substring), then
 * every word in the title, then every word across the title and keywords (description, step names), then most words,
 * then letters in order.
 */

/** 0 when `text` does not match `query`; higher is a better match. An empty query matches everything with 1. */
export function scoreText(query: string, text: string): number {
  return scoreRunbookMatch(query, { title: text });
}

/** Score of `query` against a label and its keywords (descriptions, aliases); a label match ranks above a keyword one. */
export function scoreItem(query: string, label: string, keywords: readonly string[] = []): number {
  return scoreRunbookMatch(query, { title: label, description: keywords.join(" ") });
}

/** Items that match, best first; equal scores keep their original order. */
export function filterByQuery<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => { label: string; keywords?: readonly string[] },
): T[] {
  return items
    .map((item, index) => {
      const { label, keywords } = text(item);
      return { item, index, score: scoreItem(query, label, keywords) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
