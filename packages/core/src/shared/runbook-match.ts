/**
 * One matcher for "which runbook does this text mean", shared by the command palette (a person typing) and the agent
 * tools (a model naming a runbook), so both find the same runbooks for the same words. Pure: no I/O, no framework.
 *
 * Text is folded (accents removed, lower case) and split into words; filler words are ignored. A query word matches a
 * runbook word when they are equal, when the query word starts it (three letters or more), or when they are one edit
 * apart (five letters or more), so "nginx restrat" still finds "Restart nginx". Words also match by meaning: endings are
 * ignored ("restarting" finds "Restart") and common operations words are grouped ("reboot" finds "Restart", "storage"
 * finds "Disk"). A meaning match helps a runbook surface and rank, but never on its own picks one to run.
 */

export interface MatchableRunbook {
  title: string;
  description?: string;
  /** Step titles, so "the one that checks disk usage" can match a step. */
  stepTitles?: readonly string[];
}

const IGNORED_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "could",
  "do",
  "does",
  "for",
  "from",
  "get",
  "go",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "one",
  "or",
  "our",
  "please",
  "rb",
  "run",
  "runbook",
  "runbooks",
  "should",
  "some",
  "start",
  "that",
  "the",
  "them",
  "then",
  "this",
  "to",
  "us",
  "use",
  "we",
  "what",
  "which",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Words that ask for the same operation. Each group's first word is its meaning; the groups do not overlap. Kept to
 * operations vocabulary an on-call engineer uses interchangeably.
 */
const SAME_MEANING: readonly (readonly string[])[] = [
  ["restart", "reboot", "bounce", "recycle", "cycle"],
  ["stop", "halt", "kill", "shutdown"],
  ["check", "inspect", "verify", "diagnose", "diagnostic", "healthcheck", "examine"],
  ["disk", "storage", "volume", "filesystem", "fs"],
  ["memory", "ram", "mem", "oom"],
  ["log", "journal", "journalctl", "syslog"],
  ["clean", "cleanup", "clear", "purge", "prune"],
  ["update", "upgrade", "patch"],
  ["list", "show", "display", "view"],
  ["database", "db"],
  ["certificate", "cert", "tls", "ssl"],
  ["network", "net", "connectivity"],
  ["service", "daemon"],
  ["cpu", "processor"],
];

const MEANING_OF = new Map<string, string>(
  SAME_MEANING.flatMap((group) => group.map((word) => [word, group[0] ?? word] as const)),
);

/** A word without its grammatical ending: "restarting", "restarted" and "restarts" all read "restart". */
function withoutEnding(word: string): string {
  if (word.length >= 6 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length >= 5 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length >= 5 && /(?:ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length >= 4 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The comparable root of a word: no ending and no final "e" or "y", so "expiring" and "expiry" share "expir". */
function wordStem(word: string): string {
  const stem = withoutEnding(word);
  return stem.length >= 5 && /[ey]$/.test(stem) ? stem.slice(0, -1) : stem;
}

function meaningOf(word: string): string {
  return MEANING_OF.get(word) ?? MEANING_OF.get(withoutEnding(word)) ?? wordStem(word);
}

/** How a query is compared: by spelling and meaning (finding), or by spelling only (choosing one to run). */
export interface RunbookMatchOptions {
  /** Count same-meaning words and word endings as matches. Default true. */
  meanings?: boolean;
}

/** Score tiers, highest first. A match's score is its tier plus a small bonus inside the tier. */
export const RUNBOOK_MATCH_TIER = {
  exactTitle: 1000,
  titlePrefix: 800,
  titleWordStart: 700,
  titleSubstring: 600,
  allWordsInTitle: 500,
  allWords: 300,
  mostWords: 100,
  lettersInOrder: 50,
} as const;

/** Lower case with accents removed, so "Café" and "cafe" read the same. */
export function foldText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** The meaningful words of a text, folded, without filler words ("the one that", "please run"). */
export function matchWords(value: string): string[] {
  return foldText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0 && !IGNORED_WORDS.has(word));
}

function withinOneEdit(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      // Adjacent letters swapped ("restrat") count as one edit.
      if (
        left[leftIndex] === right[rightIndex + 1] &&
        left[leftIndex + 1] === right[rightIndex]
      ) {
        leftIndex += 1;
        rightIndex += 1;
      }
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function spellingMatches(queryWord: string, word: string): boolean {
  if (queryWord === word) return true;
  if (queryWord.length >= 3 && word.startsWith(queryWord)) return true;
  return queryWord.length >= 5 && withinOneEdit(queryWord, word);
}

function anyWordMatches(queryWord: string, words: readonly string[], meanings: boolean): boolean {
  if (words.some((word) => spellingMatches(queryWord, word))) return true;
  if (!meanings) return false;
  const meaning = meaningOf(queryWord);
  return words.some((word) => meaningOf(word) === meaning);
}

function isLettersInOrder(query: string, text: string): boolean {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return false;
}

function startsAtWord(text: string, position: number): boolean {
  return position === 0 || /[^\p{L}\p{N}]/u.test(text[position - 1] ?? "");
}

/** The word tiers: every query word in the title, every word anywhere, or most words. 0 when none apply. */
function scoreByWords(query: string, runbook: MatchableRunbook, meanings: boolean): number {
  const queryWords = matchWords(query);
  if (queryWords.length === 0) return 0;
  const titleWords = matchWords(runbook.title);
  const allWords = [
    ...titleWords,
    ...matchWords(runbook.description ?? ""),
    ...(runbook.stepTitles ?? []).flatMap(matchWords),
  ];
  const inTitle = queryWords.filter((word) => anyWordMatches(word, titleWords, meanings)).length;
  const anywhere = queryWords.filter((word) => anyWordMatches(word, allWords, meanings)).length;
  // Inside a tier, more of the query found in the title ranks higher.
  const titleBonus = Math.round((inTitle / queryWords.length) * 50);
  if (inTitle === queryWords.length) return RUNBOOK_MATCH_TIER.allWordsInTitle + titleBonus;
  if (anywhere === queryWords.length) return RUNBOOK_MATCH_TIER.allWords + titleBonus;
  const needed = Math.max(2, Math.ceil((queryWords.length * 2) / 3));
  return queryWords.length >= 2 && anywhere >= needed
    ? RUNBOOK_MATCH_TIER.mostWords + titleBonus
    : 0;
}

/**
 * How well `query` names `runbook`: 0 for no match, otherwise one of {@link RUNBOOK_MATCH_TIER} plus a small bonus.
 * An empty query matches everything with 1.
 */
export function scoreRunbookMatch(
  query: string,
  runbook: MatchableRunbook,
  options: RunbookMatchOptions = {},
): number {
  const needle = foldText(query).trim();
  if (needle.length === 0) return 1;
  const title = foldText(runbook.title).trim();

  if (title === needle) return RUNBOOK_MATCH_TIER.exactTitle;
  const position = title.indexOf(needle);
  if (position === 0) return RUNBOOK_MATCH_TIER.titlePrefix;
  if (position > 0) {
    return startsAtWord(title, position)
      ? RUNBOOK_MATCH_TIER.titleWordStart
      : RUNBOOK_MATCH_TIER.titleSubstring;
  }

  const byWords = scoreByWords(query, runbook, options.meanings ?? true);
  if (byWords > 0) return byWords;

  return !needle.includes(" ") && isLettersInOrder(needle, title)
    ? RUNBOOK_MATCH_TIER.lettersInOrder
    : 0;
}

/** Runbooks that match `query`, best first; equal scores keep their original order. */
export function rankRunbooks<T extends MatchableRunbook>(
  query: string,
  runbooks: readonly T[],
): { runbook: T; score: number }[] {
  return runbooks
    .map((runbook, index) => ({ runbook, index, score: scoreRunbookMatch(query, runbook) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ runbook, score }) => ({ runbook, score }));
}

export type RunbookResolution<T> =
  | { kind: "match"; runbook: T }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "none" };

/** Candidates offered back when a name is ambiguous. */
const AMBIGUOUS_CANDIDATES = 5;

/**
 * The runbook a name or description refers to, for running it. Runbooks touch production hosts, so this only commits
 * to one when it clearly wins: the best match must cover every query word by spelling (or be a title match), not only
 * by meaning, and outrank the runner-up by a whole tier. Otherwise the ranked candidates come back for the caller to
 * choose from or ask about.
 */
export function resolveRunbookMatch<T extends MatchableRunbook>(
  query: string,
  runbooks: readonly T[],
): RunbookResolution<T> {
  if (foldText(query).trim().length === 0) return { kind: "none" };
  const ranked = rankRunbooks(query, runbooks);
  const [best, runnerUp] = ranked;
  if (best === undefined) return { kind: "none" };
  const decisive =
    scoreRunbookMatch(query, best.runbook, { meanings: false }) >= RUNBOOK_MATCH_TIER.allWords;
  const clearlyAhead =
    runnerUp === undefined || tierOf(best.score) > tierOf(runnerUp.score);
  if (decisive && clearlyAhead) return { kind: "match", runbook: best.runbook };
  return {
    kind: "ambiguous",
    candidates: ranked.slice(0, AMBIGUOUS_CANDIDATES).map(({ runbook }) => runbook),
  };
}

function tierOf(score: number): number {
  const tiers = Object.values(RUNBOOK_MATCH_TIER).sort((left, right) => right - left);
  return tiers.find((tier) => score >= tier) ?? 0;
}

/**
 * What an agent tool says when a name or description does not pick one runbook to run: the likely candidates with
 * their ids, and what to do next. Both agent runtimes use it, so a model gets the same guidance on desktop and Dashboard.
 */
export function unresolvedRunbookMessage(
  query: string,
  candidates: readonly { id: string; title: string }[],
): string {
  const list = candidates.map((candidate) => `"${candidate.title}" (runbookId ${candidate.id})`).join(", ");
  if (candidates.length === 1) {
    return `"${query}" most likely means ${list}, but not in its exact words. Confirm with the user, then call execute_runbook with that runbookId.`;
  }
  return `Several runbooks could match "${query}": ${list}. Ask the user which one, then call execute_runbook with its runbookId.`;
}
