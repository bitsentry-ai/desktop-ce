/** Case-insensitive palette search: prefix beats word start, which beats substring, which beats in-order letters. */

const SEPARATORS = new Set([" ", "-", "_", "/", ".", ":", "(", "["]);

function isSubsequence(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}

function startsAtWord(text: string, position: number): boolean {
  return position === 0 || SEPARATORS.has(text[position - 1]);
}

/** 0 when `text` does not match `query`; higher is a better match. An empty query matches everything with 1. */
export function scoreText(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return 1;
  const haystack = text.toLowerCase();
  const position = haystack.indexOf(needle);
  if (position === 0) return 4;
  if (position > 0) return startsAtWord(haystack, position) ? 3 : 2;
  return isSubsequence(needle.replaceAll(" ", ""), haystack) ? 1 : 0;
}

/** Best score over a label and its keywords; keywords rank one below the same match on the label. */
export function scoreItem(query: string, label: string, keywords: readonly string[] = []): number {
  let best = scoreText(query, label);
  for (const keyword of keywords) {
    best = Math.max(best, scoreText(query, keyword) - 1);
  }
  return best;
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
