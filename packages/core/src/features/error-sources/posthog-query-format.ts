import { DEFAULT_EXTERNAL_SOURCE_QUERY_LIMIT } from "./external-source-query.schemas";

type PostHogIssueRecord = Record<string, unknown>;

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function primitiveString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized !== "") return normalized;
    return null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function normalizeExceptionListEntries(
  exceptionList: unknown,
): Array<Record<string, unknown>> {
  const materialize = (value: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is Record<string, unknown> =>
          unknownRecord(item) !== undefined,
      );
    }

    const record = unknownRecord(value);
    if (record !== undefined) {
      if (Array.isArray(record.values)) {
        return record.values.filter(
          (item): item is Record<string, unknown> =>
            unknownRecord(item) !== undefined,
        );
      }
      return [record];
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") return [];
      try {
        return materialize(JSON.parse(trimmed));
      } catch {
        return [];
      }
    }
    return [];
  };

  return materialize(exceptionList);
}

function formatDate(value: unknown): string | null {
  const normalized = primitiveString(value);
  if (normalized === null) return null;
  const parsed = new Date(normalized);
  if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  return normalized;
}

function toCount(value: unknown): number | null {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  return null;
}

function toTrimmedString(value: unknown): string | null {
  return primitiveString(value);
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

function formatIssueIdentifier(issue: PostHogIssueRecord): string {
  const fingerprint = toTrimmedString(issue.fingerprint);
  if (fingerprint !== null) return fingerprint;
  const id = toTrimmedString(issue.id);
  if (id !== null) return id;
  return "(unknown fingerprint)";
}

function deriveTitleFromMetadata(issue: PostHogIssueRecord): string | null {
  const metadata = unknownRecord(issue.metadata);
  if (metadata === undefined) return null;

  const entries = normalizeExceptionListEntries(metadata.exception_list);
  for (const entry of entries) {
    const exceptionType = toTrimmedString(entry.type);
    const message =
      toTrimmedString(entry.value) ?? toTrimmedString(entry.message);
    const title = titleFromExceptionParts(exceptionType, message);
    if (title !== null) return title;
  }

  return null;
}

function titleFromExceptionParts(
  exceptionType: string | null,
  message: string | null,
): string | null {
  if (exceptionType !== null && message !== null)
    return `${exceptionType}: ${message}`;
  return message ?? exceptionType;
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

function postHogIssueRecord(value: unknown): PostHogIssueRecord {
  return unknownRecord(value) ?? {};
}

function countLabel(value: number | null): string | null {
  if (value === null) return null;
  return String(value);
}

function pushLine(lines: string[], line: string | null): void {
  if (line !== null) lines.push(line);
}

function issueTitle(issue: PostHogIssueRecord): string {
  return (
    toTrimmedString(issue.title) ??
    toTrimmedString(issue.exceptionType) ??
    toTrimmedString(issue.message) ??
    deriveTitleFromMetadata(issue) ??
    "Untitled exception"
  );
}

function formatPostHogIssue(issue: PostHogIssueRecord, index: number): string {
  const eventCount = toCount(issue.count ?? issue.eventCount);
  const userCount = toCount(issue.userCount);
  const lines = [
    `${String(index + 1)}. ${issueTitle(issue)}`,
    `Fingerprint: ${formatIssueIdentifier(issue)}`,
  ];

  pushLine(
    lines,
    formatOptionalPair(
      "Level / Status",
      toTrimmedString(issue.level),
      toTrimmedString(issue.status),
    ),
  );
  pushLine(
    lines,
    formatOptionalPair(
      "Project / Environment",
      toTrimmedString(issue.projectIdentifier),
      toTrimmedString(issue.environment),
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

export function formatPostHogExternalSourceQueryResults(input: {
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
    `Provider: ${input.sourceType ?? "posthog"}`,
    `Query: ${input.query}`,
    formatReturnedLine(input.issues.length, input.hasMore, limit),
  ];

  if (input.issues.length === 0) {
    return [...header, "", "No matching exceptions found."].join("\n");
  }

  const formattedIssues = input.issues.map((rawIssue, index) =>
    formatPostHogIssue(postHogIssueRecord(rawIssue), index),
  );

  return [...header, "", ...formattedIssues].join("\n\n");
}
