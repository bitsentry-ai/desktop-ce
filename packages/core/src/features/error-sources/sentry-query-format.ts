import { DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT } from "./external-source-query.schemas";

type SentryIssueRecord = Record<string, unknown>;

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function primitiveString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "") return trimmed;
    return null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function parseIssueTags(tags: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      addIssueTag(output, tag);
    }

    return output;
  }

  const tagRecord = unknownRecord(tags);
  if (tagRecord !== undefined) {
    for (const [key, value] of Object.entries(tagRecord)) {
      const normalizedKey = key.trim();
      if (normalizedKey === "") continue;
      output[normalizedKey] = value;
    }
  }

  return output;
}

function addIssueTag(output: Record<string, unknown>, tag: unknown): void {
  if (Array.isArray(tag) && tag.length >= 2) {
    const key = primitiveString(tag[0]);
    if (key !== null) output[key] = tag[1];
    return;
  }

  const record = unknownRecord(tag);
  const key = primitiveString(record?.key);
  if (key !== null) output[key] = record?.value;
}

function extractTagValue(
  tags: Record<string, unknown>,
  tagKey: string,
): string | null {
  const value = tags[tagKey];
  if (value == null) return null;

  return primitiveString(value);
}

export function extractIssueField(
  issue: unknown,
  tagKey: string,
): string | null {
  const parsedTags = parseIssueTags(unknownRecord(issue)?.tags);
  return extractTagValue(parsedTags, tagKey);
}

function formatDate(value: unknown): string | null {
  const normalized = primitiveString(value);
  if (normalized === null) return null;

  const parsed = new Date(normalized);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return normalized;
}

function formatIssueIdentifier(issue: SentryIssueRecord): string {
  const shortId = primitiveString(issue.shortId);
  if (shortId !== null) return shortId;

  const issueId = primitiveString(issue.id);
  if (issueId !== null) return issueId;

  return "(unknown issue id)";
}

function formatOptionalPair(
  label: string,
  left: string | null,
  right: string | null,
): string | null {
  if (left !== null && right !== null) return `${label}: ${left} / ${right}`;
  if (left !== null) return `${label}: ${left}`;
  if (right !== null) return `${label}: ${right}`;
  return null;
}

function toCount(value: unknown): number | null {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function countLabel(value: number | null): string | null {
  if (value === null) return null;
  return String(value);
}

function formatReturnedLine(
  issueCount: number,
  hasMore: boolean,
  limit: number,
): string {
  let suffix = "";
  if (hasMore) {
    suffix = ` (showing first ${String(limit)}; more available)`;
  }

  return `Returned: ${String(issueCount)} issue(s)${suffix}`;
}

function sentryIssueRecord(value: unknown): SentryIssueRecord {
  return unknownRecord(value) ?? {};
}

function projectSlug(issue: SentryIssueRecord): string | null {
  return primitiveString(unknownRecord(issue.project)?.slug);
}

function issueTitle(issue: SentryIssueRecord): string {
  return (
    primitiveString(issue.title) ??
    primitiveString(issue.culprit) ??
    "Untitled issue"
  );
}

function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

function formatSentryIssue(issue: SentryIssueRecord, index: number): string {
  const environment = extractIssueField(issue, "environment");
  const eventCount = toCount(issue.count);
  const userCount = toCount(issue.userCount);
  const lines = [
    `${String(index + 1)}. ${issueTitle(issue)}`,
    `Issue: ${formatIssueIdentifier(issue)}`,
  ];

  pushLine(
    lines,
    formatOptionalPair(
      "Level / Status",
      primitiveString(issue.level),
      primitiveString(issue.status),
    ),
  );
  pushLine(
    lines,
    formatOptionalPair(
      "Project / Environment",
      projectSlug(issue),
      environment,
    ),
  );
  pushLine(
    lines,
    formatOptionalPair(
      "Events / Users",
      countLabel(eventCount),
      countLabel(userCount),
    ),
  );
  pushLine(
    lines,
    formatOptionalPair(
      "First seen / Last seen",
      formatDate(issue.firstSeen),
      formatDate(issue.lastSeen),
    ),
  );

  return lines.join("\n");
}

export function formatSentryExternalSourceQueryResults(input: {
  sourceName: string;
  sourceType?: string;
  query: string;
  issues: unknown[];
  hasMore: boolean;
  limit?: number;
}): string {
  const limit = input.limit ?? DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT;
  const header = [
    "External Source Query Results",
    `Source: ${input.sourceName}`,
    `Provider: ${input.sourceType ?? "sentry"}`,
    `Query: ${input.query}`,
    formatReturnedLine(input.issues.length, input.hasMore, limit),
  ];

  if (input.issues.length === 0) {
    return [...header, "", "No matching issues found."].join("\n");
  }

  const formattedIssues = input.issues.map((rawIssue, index) =>
    formatSentryIssue(sentryIssueRecord(rawIssue), index),
  );

  return [...header, "", ...formattedIssues].join("\n\n");
}
