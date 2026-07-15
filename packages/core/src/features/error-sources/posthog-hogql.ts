/**
 * Pure / framework-free helpers shared by the desktop, backend, and worker
 * PostHog adapters. These cover error-body parsing, HogQL string escaping,
 * row-to-record shaping, level normalization, the issues / events query
 * builders, the +1 over-fetch pagination cursor, and the Sentry-shaped issue
 * and event records consumed by the sync pipeline.
 *
 * Anything here must remain Node/browser-agnostic — no fetch, no abort
 * signals, no platform imports. The HTTP transport stays in each consumer.
 */

import { z } from "zod";

function nullToUndefined<T>(value: T | null | undefined): T | undefined {
  if (value == null) return undefined;
  return value;
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function postHogCellToString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
    return null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

/**
 * Runtime shape of the PostHog `/api/projects/{id}/query/` response that we
 * actually consume. We keep `results` as `unknown[][]` because the cell
 * layout depends on the SELECT, and convert rows via `rowToObject` before
 * touching individual columns. Defining the schema (and `.parse(...)`-ing
 * the JSON in adapters) prevents a malicious or buggy upstream from
 * smuggling a non-array `results` into the row builders.
 */
export const postHogHogQLResponseSchema = z
  .object({
    results: z.array(z.array(z.unknown())).optional(),
    columns: z.array(z.string()).optional(),
    hasMore: z.preprocess(
      (value) => nullToUndefined(value),
      z.boolean().optional(),
    ),
    has_more: z.preprocess(
      (value) => nullToUndefined(value),
      z.boolean().optional(),
    ),
    limit: z.preprocess(
      (value) => nullToUndefined(value),
      z.number().optional(),
    ),
    offset: z.preprocess(
      (value) => nullToUndefined(value),
      z.number().optional(),
    ),
  })
  .loose();

export type PostHogHogQLResponse = z.infer<typeof postHogHogQLResponseSchema>;

/**
 * Parse a HogQL response body. Returns the validated value or throws a
 * descriptive error — never returns an unchecked cast. Use this instead of
 * `(await response.json()) as PostHogHogQLResponse` so malformed upstream
 * data fails fast before reaching the row decoders.
 */
export function parsePostHogHogQLResponse(
  payload: unknown,
): PostHogHogQLResponse {
  return postHogHogQLResponseSchema.parse(payload);
}

export interface PostHogIssueQueryInput {
  projectId: string;
  searchQuery?: string;
  since?: string;
  /**
   * Upper bound on each fingerprint's `max(timestamp)`. Set to the sync's
   * captured start time so OFFSET-paginated reads see a stable snapshot
   * even when new events arrive mid-sync. Fingerprints whose newest event
   * lands after `until` are filtered out this run and picked up next run
   * (since `next.since = current.until`).
   */
  until?: string;
  limit: number;
  offset?: number;
}

export interface PostHogEventQueryInput {
  projectId: string;
  fingerprint: string;
  limit: number;
  offset?: number;
  /**
   * When set, restrict the per-event scan to `timestamp >= since`. Used by
   * incremental syncs so we don't reread every historical event on a known
   * fingerprint just because one new exception arrived.
   */
  since?: string;
  /**
   * Upper bound on `timestamp`. Set to the sync's captured start time so
   * OFFSET-paginated reads see a stable snapshot of events even when new
   * exceptions land mid-sync; rows past `until` are picked up next run.
   */
  until?: string;
}

/**
 * Quote a string literal for embedding into a HogQL query. Handles backslash
 * and single-quote escaping. The +1 over-fetch convention is implemented in
 * the query builders; callers should not append their own LIMIT clauses.
 */
export function quoteHogQLString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Runbook prompts often show queries as inline Markdown code (for example
 * `error`). If the user copies the backticks into the action field, PostHog
 * sees them as literal search characters and returns no matches. Strip only
 * whole-query Markdown code wrappers; preserve all other text verbatim.
 */
export function normalizePostHogSearchQuery(value: string): string {
  const trimmed = value.trim();
  const fencedBody = unwrapFencedMarkdownCode(trimmed);
  if (fencedBody !== null) return fencedBody;

  const inlineBody = unwrapInlineMarkdownCode(trimmed);
  if (inlineBody !== null) return inlineBody;

  return trimmed;
}

function unwrapFencedMarkdownCode(value: string): string | null {
  const fenced = value.match(/^```[^\n`]*\n?([\s\S]*?)\n?```$/);
  const fencedBody = fenced?.[1]?.trim();
  if (fencedBody !== undefined && fencedBody !== "") return fencedBody;
  return null;
}

function unwrapInlineMarkdownCode(value: string): string | null {
  const inline = value.match(/^`([^`\n]+)`$/);
  const inlineBody = inline?.[1]?.trim();
  if (inlineBody !== undefined && inlineBody !== "") return inlineBody;
  return null;
}

function padUtcComponent(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/**
 * Convert an ISO-ish timestamp into an explicit UTC DateTime64(6) HogQL
 * literal. PostHog's query engine accepts plain datetime strings in some
 * contexts, but the sync pagination filters compare against
 * `DateTime64(6, 'UTC')` values (`timestamp`, `max(timestamp)`), and
 * shipping a raw ISO-8601 string with `T`/`Z` there causes the server to
 * treat it as `String` and reject the comparison.
 */
export function quoteHogQLUtcDateTime64(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid PostHog timestamp filter: ${value}`);
  }

  const formatted =
    `${String(parsed.getUTCFullYear())}-${padUtcComponent(parsed.getUTCMonth() + 1)}-${padUtcComponent(parsed.getUTCDate())} ` +
    `${padUtcComponent(parsed.getUTCHours())}:${padUtcComponent(parsed.getUTCMinutes())}:${padUtcComponent(parsed.getUTCSeconds())}.` +
    `${padUtcComponent(parsed.getUTCMilliseconds(), 3)}000`;

  return `toDateTime64(${quoteHogQLString(formatted)}, 6, 'UTC')`;
}

/** Pick the first non-empty trimmed string from a list of unknown values. */
export function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value == null) continue;
    const normalized = postHogCellToString(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

/** Convert a raw value into an ISO timestamp string, or null when invalid. */
export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const normalized = postHogCellToString(value);
  if (normalized === null) return null;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Convert a raw value into an ISO timestamp, falling back to "now". */
export function toIsoOrNow(value: unknown): string {
  return toIsoOrNull(value) ?? new Date().toISOString();
}

/**
 * Map a HogQL-result row (positional `unknown[]`) into a column-keyed object.
 * Columns missing from the row are simply set to `undefined`.
 */
export function rowToObject(
  row: unknown[],
  columns: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]] = row[i];
  }
  return out;
}

/**
 * Normalize a PostHog `$exception_level` (or similar) into the Sentry level
 * vocabulary used by the rest of the pipeline. Defaults to `error` when the
 * input is unrecognised so events still flow through level-threshold filters.
 */
export function mapPostHogLevelToCanonical(value: unknown): string {
  const normalized = postHogCellToString(value)?.toLowerCase();
  if (normalized === undefined) return "error";
  return POSTHOG_LEVELS[normalized] ?? "error";
}

const POSTHOG_LEVELS: Record<string, string> = {
  critical: "fatal",
  fatal: "fatal",
  error: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
  log: "info",
  debug: "debug",
};

/**
 * Extract a human-readable error message from a PostHog API error body.
 * Falls back to a truncated raw body, or a generic placeholder when blank.
 */
export function parsePostHogErrorBody(raw: string | null): string {
  if (raw === null || raw === "") return "Unknown PostHog API error";
  const parsedMessage = parsePostHogJsonErrorMessage(raw);
  if (parsedMessage !== null) return parsedMessage;
  return raw.slice(0, 300);
}

function parsePostHogJsonErrorMessage(raw: string): string | null {
  try {
    const parsed = unknownRecord(JSON.parse(raw));
    return pickFirstString(
      parsed?.detail,
      parsed?.error_description,
      parsed?.error,
      parsed?.message,
    );
  } catch {
    return null;
  }
}

/** Decode a HogQL pagination cursor into a non-negative integer offset. */
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const parsed = Number(cursor);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  return 0;
}

/** Encode a HogQL offset back into a string cursor. */
export function encodeOffsetCursor(offset: number): string {
  return String(offset);
}

/**
 * Decode a per-project HogQL cursor into a `projectId -> offset` map. The
 * cursor is JSON-encoded `{projectId: offset}` so each project can advance
 * independently — necessary because issues from different projects only
 * appear in different pages once their `lastSeen` ordering interleaves, and
 * a single global offset would skip rows from quieter projects forever.
 *
 * Falls back to an empty record for any malformed cursor; the consumer then
 * starts every project at offset 0, which keeps the failure mode "show too
 * much" rather than "skip rows silently".
 */
export function decodePerProjectCursor(
  cursor: string | undefined,
): Record<string, number> {
  if (cursor === undefined || cursor === "") return {};
  try {
    const parsed = unknownRecord(JSON.parse(cursor));
    if (parsed === undefined) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const offset = Number(value);
      if (Number.isFinite(offset) && offset >= 0) {
        out[key] = Math.trunc(offset);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Encode a `projectId -> offset` map back into a JSON cursor string. */
export function encodePerProjectCursor(
  offsets: Record<string, number>,
): string {
  return JSON.stringify(offsets);
}

/**
 * Split a namespaced PostHog issue id (`${projectId}:${fingerprint}`) back
 * into its components. When the id is not namespaced, `projectId` is
 * `undefined` and the whole id is treated as the fingerprint.
 */
export function extractPostHogIssueFingerprint(issueId: string): {
  projectId?: string;
  fingerprint: string;
} {
  const colonIndex = issueId.indexOf(":");
  if (colonIndex < 0) {
    return { fingerprint: issueId };
  }
  return {
    projectId: issueId.slice(0, colonIndex),
    fingerprint: issueId.slice(colonIndex + 1),
  };
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

function extractIssueTitlePartsFromExceptionList(exceptionList: unknown): {
  exceptionType: string | null;
  message: string | null;
} {
  for (const record of normalizeExceptionListEntries(exceptionList)) {
    const exceptionType = pickFirstString(record.type);
    const message = pickFirstString(record.value, record.message);
    if (exceptionType !== null || message !== null) {
      return { exceptionType, message };
    }
  }

  return { exceptionType: null, message: null };
}

/**
 * Build a Sentry-shaped issue record from a HogQL row. Namespaces the issue
 * id by project so the same fingerprint emitted from two PostHog projects
 * under one source cannot collide on the upsert key. Always exposes the raw
 * fingerprint so callers that need the un-namespaced id (e.g. event lookup)
 * don't have to re-split.
 */
export function buildPostHogIssueRecord(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const fingerprint = pickFirstString(row.fingerprint, row.id) ?? "";
  const exceptionListParts = extractIssueTitlePartsFromExceptionList(
    row.exception_list,
  );
  const exceptionType = pickFirstString(
    row.exception_type,
    row.type,
    exceptionListParts.exceptionType,
  );
  const message = pickFirstString(
    row.message,
    row.exception_message,
    exceptionListParts.message,
  );
  const title = buildPostHogIssueTitle(exceptionType, message);

  const level = mapPostHogLevelToCanonical(row.level);
  const firstSeen = toIsoOrNow(row.first_seen);
  const lastSeen = toIsoOrNow(row.last_seen);
  const eventCount = Number(row.event_count ?? row.count ?? 0);
  const userCount = postHogOptionalNumber(row.user_count);

  const environment = pickFirstString(row.environment);
  const projectId = pickFirstString(row.project_id);
  const lib = pickFirstString(row.lib);
  const tags: Array<[string, unknown]> = [];
  addTag(tags, "environment", environment);
  addTag(tags, "project", projectId);
  addTag(tags, "library", lib);

  const namespacedId = namespacedPostHogIssueId(projectId, fingerprint);

  return {
    id: namespacedId,
    fingerprint,
    shortId: shortPostHogIssueId(fingerprint),
    title,
    message,
    exceptionType,
    culprit: null,
    type: exceptionType,
    level,
    status: "unresolved",
    firstSeen,
    lastSeen,
    count: eventCount,
    eventCount,
    userCount,
    platform: lib,
    tags,
    project: projectFromPostHogId(projectId),
    projectIdentifier: projectId,
    environment,
    metadata: row,
  };
}

function postHogOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  return Number(value);
}

function buildPostHogIssueTitle(
  exceptionType: string | null,
  message: string | null,
): string {
  if (exceptionType !== null && message !== null)
    return `${exceptionType}: ${message}`;
  return message ?? exceptionType ?? "Untitled exception";
}

function addTag(
  tags: Array<[string, unknown]>,
  name: string,
  value: string | null,
): void {
  if (value !== null) tags.push([name, value]);
}

function namespacedPostHogIssueId(
  projectId: string | null,
  fingerprint: string,
): string {
  if (fingerprint === "") return "";
  if (projectId !== null) return `${projectId}:${fingerprint}`;
  return fingerprint;
}

function shortPostHogIssueId(fingerprint: string): string | null {
  if (fingerprint === "") return null;
  return fingerprint.slice(0, 12);
}

function projectFromPostHogId(
  projectId: string | null,
): { slug: string } | null {
  if (projectId === null) return null;
  return { slug: projectId };
}

function buildExceptionEntries(
  exceptionList: unknown,
  fallbackType: string | null,
  fallbackValue: string | null,
): Array<{ type: string; data: { values: Array<Record<string, unknown>> } }> {
  const normalizedEntries = normalizeExceptionListEntries(exceptionList);
  if (normalizedEntries.length > 0) {
    const values = normalizedEntries.map((item) => ({
      type: pickFirstString(item.type) ?? fallbackType ?? null,
      value: pickFirstString(item.value) ?? fallbackValue ?? null,
      stacktrace: unknownRecord(item.stacktrace) ?? null,
      mechanism: unknownRecord(item.mechanism) ?? null,
    }));
    if (values.length > 0) {
      return [{ type: "exception", data: { values } }];
    }
  }

  if (fallbackType !== null || fallbackValue !== null) {
    return [
      {
        type: "exception",
        data: {
          values: [
            {
              type: fallbackType,
              value: fallbackValue,
              stacktrace: null,
              mechanism: null,
            },
          ],
        },
      },
    ];
  }

  return [];
}

/** Build a Sentry-shaped event record from a HogQL row. */
export function buildPostHogEventRecord(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const eventId = pickFirstString(row.uuid, row.id) ?? "";
  const dateCreated = toIsoOrNow(row.timestamp);
  const exceptionType = pickFirstString(row.exception_type);
  const message = pickFirstString(row.message);
  const level = mapPostHogLevelToCanonical(row.level);
  const environment = pickFirstString(row.environment);
  const sessionId = pickFirstString(row.session_id);
  const currentUrl = pickFirstString(row.current_url);
  const browser = pickFirstString(row.browser);
  const os = pickFirstString(row.os);
  const lib = pickFirstString(row.lib);
  const personId = pickFirstString(row.person_id);

  const entries = buildExceptionEntries(
    row.exception_list,
    exceptionType,
    message,
  );

  const tags: Array<[string, unknown]> = [];
  addTag(tags, "environment", environment);
  addTag(tags, "session_id", sessionId);
  addTag(tags, "library", lib);

  const contexts: Record<string, unknown> = {};
  addNamedContext(contexts, "browser", browser);
  addNamedContext(contexts, "os", os);
  // PostHog's `$session_id` is a browsing-session identifier, not an
  // OpenTelemetry-style trace id. Writing it into `contexts.trace.trace_id`
  // would surface fake trace ids in downstream diagnosis UIs and grouping.
  // The session id is preserved as a tag above; expose it separately under
  // a session context for callers that explicitly want it.
  if (sessionId !== null) contexts.session = { session_id: sessionId };

  return {
    id: eventId,
    eventID: eventId,
    dateCreated,
    level,
    message,
    entries,
    tags,
    contexts,
    user: userFromPostHogPersonId(personId),
    request: requestFromPostHogUrl(currentUrl),
    environment,
    release: null,
    serverName: null,
    // PostHog exception events don't carry a Sentry-style "transaction name"
    // (the named code path that produced the exception). Leaving this null
    // is correct; copying `$current_url` here would mis-label the event
    // record's `transactionName` column with a page URL.
    transaction: null,
    platform: lib,
  };
}

function addNamedContext(
  contexts: Record<string, unknown>,
  name: string,
  value: string | null,
): void {
  if (value !== null) contexts[name] = { name: value };
}

function userFromPostHogPersonId(
  personId: string | null,
): { id: string } | null {
  if (personId === null) return null;
  return { id: personId };
}

function requestFromPostHogUrl(
  currentUrl: string | null,
): { url: string } | null {
  if (currentUrl === null) return null;
  return { url: currentUrl };
}

/**
 * Build the HogQL query string for the per-project exception aggregation that
 * powers `listIssues`/`queryIssues`. The query over-fetches by 1 so callers
 * can detect `hasMore` without a second round-trip.
 *
 * `since` is applied as a `HAVING max(timestamp) >= since` filter after the
 * `GROUP BY`, so incremental syncs only see fingerprints whose newest event
 * landed in the window — but the per-fingerprint aggregates (`count()`,
 * `min(timestamp)`, `count(DISTINCT person_id)`) still describe the full
 * lifetime of the exception. A pre-aggregation `WHERE timestamp >= since`
 * would shrink those aggregates and cause the upstream upsert to overwrite
 * persisted firstSeen/count with values from the incremental slice.
 */
export function buildPostHogIssuesHogQL(input: PostHogIssueQueryInput): string {
  const whereFilters = buildPostHogIssueWhereFilters(input.searchQuery);
  const havingClause = buildPostHogIssueHavingClause(input);

  const offset = input.offset ?? 0;
  // For each fingerprint group, prefer the level/message/type/lib/environment
  // from the most recent event (argMax over (timestamp, uuid)). Tying the
  // argMax key with `uuid` breaks ambiguity between equal-timestamp events
  // within one fingerprint, otherwise the "latest" metadata winner is
  // arbitrary and can flip between syncs even when no new events have
  // arrived. `any()` would be non-deterministic for the same reason, which
  // also propagates into diagnosis severity downstream.
  return `SELECT
      properties.$exception_fingerprint AS fingerprint,
      argMax(properties.$exception_message, tuple(timestamp, uuid)) AS message,
      argMax(properties.$exception_type, tuple(timestamp, uuid)) AS exception_type,
      argMax(properties.$exception_level, tuple(timestamp, uuid)) AS level,
      argMax(properties.$lib, tuple(timestamp, uuid)) AS lib,
      argMax(properties.environment, tuple(timestamp, uuid)) AS environment,
      count() AS event_count,
      count(DISTINCT person_id) AS user_count,
      min(timestamp) AS first_seen,
      max(timestamp) AS last_seen,
      argMax(properties.$exception_list, tuple(timestamp, uuid)) AS exception_list,
      ${quoteHogQLString(input.projectId)} AS project_id
    FROM events
    WHERE ${whereFilters.join(" AND ")}
    GROUP BY properties.$exception_fingerprint
    ${havingClause}
    ORDER BY last_seen DESC, fingerprint ASC
	    LIMIT ${String(input.limit + 1)}
	    OFFSET ${String(offset)}`;
}

function buildPostHogIssueWhereFilters(
  searchQuery: string | undefined,
): string[] {
  const whereFilters: string[] = ["event = '$exception'"];
  const trimmedQuery = normalizePostHogSearchQuery(searchQuery ?? "");
  if (trimmedQuery.length === 0) return whereFilters;

  const escaped = quoteHogQLString(`%${trimmedQuery}%`);
  whereFilters.push(
    `(` +
      `properties.$exception_message ILIKE ${escaped} ` +
      `OR properties.$exception_type ILIKE ${escaped} ` +
      `OR properties.$exception_fingerprint ILIKE ${escaped} ` +
      `OR toString(properties.$exception_list) ILIKE ${escaped}` +
      `)`,
  );
  return whereFilters;
}

function buildPostHogIssueHavingClause(input: PostHogIssueQueryInput): string {
  const havingFilters: string[] = [];
  addTimestampFilter(havingFilters, "max(timestamp) >=", input.since);
  addTimestampFilter(havingFilters, "max(timestamp) <=", input.until);
  if (havingFilters.length === 0) return "";
  return `HAVING ${havingFilters.join(" AND ")}`;
}

function addTimestampFilter(
  filters: string[],
  prefix: string,
  value: string | undefined,
): void {
  if (value === undefined || value === "") return;
  filters.push(`${prefix} ${quoteHogQLUtcDateTime64(value)}`);
}

/**
 * Build the HogQL query for the per-fingerprint event detail used by
 * `listIssueEvents`. Also uses the +1 over-fetch convention. When `since`
 * is set the per-event scan is restricted to that window so incremental
 * syncs don't reread entire historical event histories on known
 * fingerprints.
 */
export function buildPostHogEventsHogQL(input: PostHogEventQueryInput): string {
  const offset = input.offset ?? 0;
  const filters: string[] = [
    "event = '$exception'",
    `properties.$exception_fingerprint = ${quoteHogQLString(input.fingerprint)}`,
  ];
  if (input.since !== undefined && input.since !== "") {
    filters.push(`timestamp >= ${quoteHogQLUtcDateTime64(input.since)}`);
  }
  if (input.until !== undefined && input.until !== "") {
    // Bound the event scan above so OFFSET pagination is stable during a
    // sync. Events past `until` are visible to the next sync run via the
    // `since = previous.until` watermark.
    filters.push(`timestamp <= ${quoteHogQLUtcDateTime64(input.until)}`);
  }
  return `SELECT
      uuid,
      timestamp,
      properties.$exception_message AS message,
      properties.$exception_type AS exception_type,
      properties.$exception_level AS level,
      properties.$exception_list AS exception_list,
      properties.environment AS environment,
      properties.$session_id AS session_id,
      properties.$current_url AS current_url,
      properties.$browser AS browser,
      properties.$os AS os,
      properties.$lib AS lib,
      person_id
    FROM events
    WHERE ${filters.join(" AND ")}
    ORDER BY timestamp DESC, uuid ASC
	    LIMIT ${String(input.limit + 1)}
	    OFFSET ${String(offset)}`;
}

export interface PerProjectIssueResult {
  projectId: string;
  /**
   * Issues fetched in this project, tagged with their incoming `__projectId`.
   * The tag is stripped before issues are returned to the caller.
   */
  issues: Array<Record<string, unknown>>;
  /** Offset this fetch started at (the value already in the cursor). */
  startOffset: number;
  /**
   * Whether the per-project query reported more rows beyond what was
   * fetched (i.e. the +1 over-fetch sentinel fired or the API said so).
   */
  hasMore: boolean;
}

/**
 * Merge per-project HogQL issue results into one page sorted by `lastSeen`
 * desc, sliced to the global `limit`, and produce next-page per-project
 * offsets so the caller can advance only the projects whose rows were
 * actually consumed.
 *
 * The per-project offset map is the cursor: each project advances by exactly
 * the number of merged rows that came from it, so the next call resumes
 * each project where the merge stopped reading. A single global offset would
 * either skip rows from quieter projects or replay rows from busier ones.
 */
export function mergePostHogIssuesByRecency(
  perProjectResults: Array<PerProjectIssueResult>,
  limit: number,
): {
  issues: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextOffsets: Record<string, number>;
} {
  const mergeState = createPostHogMergeState(perProjectResults);

  mergeState.tagged.sort((a, b) => {
    return issueLastSeenTimestamp(b.issue) - issueLastSeenTimestamp(a.issue);
  });

  const consumedSlice = mergeState.tagged.slice(0, limit);
  const consumedByProject = countConsumedPostHogIssuesByProject(consumedSlice);

  // A project still has more pages to fetch if either:
  // - it returned its full per-project page and the over-fetch sentinel
  //   indicated more rows are reachable beyond the slice, OR
  // - its per-project fetch produced more rows than the merge ended up
  //   consuming (the unconsumed rows still need to be returned next page).
  const candidateNextOffsets: Record<string, number> = {};
  let anyHasMore = false;
  for (const result of perProjectResults) {
    const consumed = consumedByProject.get(result.projectId) ?? 0;
    const fetched = result.issues.length;
    const startOffset =
      mergeState.projectStart.get(result.projectId) ?? result.startOffset;
    const hadMore = mergeState.projectHasMore.get(result.projectId) ?? false;
    // `consumed` rows were emitted on this page; the remaining `fetched -
    // consumed` rows are still in this project's offset window, so the next
    // request resumes at `startOffset + consumed`.
    const nextOffset = startOffset + consumed;
    candidateNextOffsets[result.projectId] = nextOffset;
    if (consumed < fetched || hadMore) {
      anyHasMore = true;
    }
  }

  return {
    issues: consumedSlice.map((item) => item.issue),
    hasMore: anyHasMore,
    nextOffsets: nextOffsetsForMergedIssues(anyHasMore, candidateNextOffsets),
  };
}

function countConsumedPostHogIssuesByProject(
  consumedSlice: Array<{ projectId: string; issue: Record<string, unknown> }>,
): Map<string, number> {
  const consumedByProject = new Map<string, number>();
  for (const item of consumedSlice) {
    consumedByProject.set(
      item.projectId,
      (consumedByProject.get(item.projectId) ?? 0) + 1,
    );
  }
  return consumedByProject;
}

function createPostHogMergeState(
  perProjectResults: Array<PerProjectIssueResult>,
): {
  tagged: Array<{ projectId: string; issue: Record<string, unknown> }>;
  projectHasMore: Map<string, boolean>;
  projectStart: Map<string, number>;
} {
  const tagged: Array<{ projectId: string; issue: Record<string, unknown> }> =
    [];
  const projectHasMore = new Map<string, boolean>();
  const projectStart = new Map<string, number>();

  for (const result of perProjectResults) {
    projectHasMore.set(result.projectId, result.hasMore);
    projectStart.set(result.projectId, result.startOffset);
    for (const issue of result.issues) {
      tagged.push({ projectId: result.projectId, issue });
    }
  }

  return { tagged, projectHasMore, projectStart };
}

function issueLastSeenTimestamp(issue: Record<string, unknown>): number {
  if (typeof issue.lastSeen !== "string") return 0;
  const timestamp = Date.parse(issue.lastSeen);
  if (Number.isFinite(timestamp)) return timestamp;
  return 0;
}

function nextOffsetsForMergedIssues(
  hasMore: boolean,
  candidateNextOffsets: Record<string, number>,
): Record<string, number> {
  if (hasMore) return candidateNextOffsets;
  return {};
}
