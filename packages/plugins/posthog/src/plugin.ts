import type { DesktopCodePlugin } from "@bitsentry-ce/core/features/plugins";

const POSTHOG_DEFAULT_BASE_URL = "https://us.posthog.com";
const DEFAULT_ISSUES_LIMIT = 50;
const DEFAULT_EVENTS_LIMIT = 50;
const MAX_LIMIT = 100;

function readString(value, fallback = "") {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return fallback;
}

function requireString(value, fieldName) {
  const normalized = readString(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readRecord(value): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value;
}

function resolvePostHogErrorSourceSetup(context) {
  const setupValues = readRecord(context.setupValues);
  const authToken = readString(setupValues.authToken);
  const baseUrl = readString(setupValues.baseUrl);
  const orgSlug = readString(
    setupValues.orgSlug,
    readString(setupValues.organizationId),
  );
  const projectIds = readStringArray(setupValues.projectIds);
  const configuration: Record<string, unknown> = {};
  if (baseUrl.length > 0) {
    configuration.baseUrl = baseUrl;
  }
  if (orgSlug.length > 0) {
    configuration.orgSlug = orgSlug;
  }
  if (projectIds.length > 0) {
    configuration.projectIds = projectIds;
  }

  return {
    accessTokenRef: authToken.length > 0 ? authToken : undefined,
    configuration,
  };
}

function buildPostHogErrorSourceAuthFromParts(accessTokenRef, configuration) {
  const config = readRecord(configuration);
  const auth = { ...config };
  const accessToken = readString(accessTokenRef);
  if (accessToken.length > 0) {
    auth.authToken = accessToken;
    auth.accessToken = accessToken;
  }
  const orgSlug = readString(config.orgSlug);
  if (orgSlug.length > 0) {
    auth.organizationId = orgSlug;
  }

  return auth;
}

function buildPostHogErrorSourceAuth(context) {
  const source = readRecord(context.source);
  return buildPostHogErrorSourceAuthFromParts(
    source.accessTokenRef,
    source.configuration,
  );
}

function buildPostHogErrorSourceProbeAuth(context) {
  const persistedSetup = readRecord(context.persistedSetup);
  return buildPostHogErrorSourceAuthFromParts(
    persistedSetup.accessTokenRef,
    persistedSetup.configuration,
  );
}

function boundedLimit(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
  }

  return fallback;
}

function resolvePostHogBaseUrl(baseUrl) {
  const normalized = readString(baseUrl, POSTHOG_DEFAULT_BASE_URL);
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("PostHog base URL must use http:// or https://");
  }

  return parsed.origin;
}

function readApiBase(auth) {
  return resolvePostHogBaseUrl(auth.baseUrl ?? auth.apiBase);
}

function oauthUrl(auth, pathname) {
  return new URL(pathname, readApiBase(auth)).toString();
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
}

function pickFirstString(...values) {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
}

function unknownRecord(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return null;
}

function parseErrorBody(raw) {
  if (raw.length === 0) {
    return "Unknown PostHog API error";
  }

  try {
    const parsed = unknownRecord(JSON.parse(raw));
    const message = pickFirstString(
      parsed?.detail,
      parsed?.error_description,
      parsed?.error,
      parsed?.message,
    );
    if (message !== null) {
      return message;
    }
  } catch {
    // Keep the raw response body below.
  }

  return raw.slice(0, 300);
}

function retryDelay(response, fallbackMs) {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader === null) {
    return fallbackMs;
  }

  const retryAfterSeconds = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(500, retryAfterSeconds * 1_000);
  }

  return fallbackMs;
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function requestPostHog(url, init, maxAttempts = 5) {
  let attempt = 0;
  let delayMs = 1_000;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await fetch(url, {
      ...init,
      redirect: "error",
    });
    if (response.ok) {
      return response;
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      const body = await response.text().catch(() => "");
      throw new Error(`PostHog API ${String(response.status)}: ${parseErrorBody(body)}`);
    }

    await wait(retryDelay(response, delayMs));
    delayMs = Math.min(delayMs * 2, 30_000);
  }

  throw new Error("PostHog API request failed after retries");
}

function normalizeTokenResponse(payload) {
  const accessToken = readString(payload?.access_token);
  if (accessToken.length === 0) {
    throw new Error("PostHog OAuth response did not include an access token");
  }

  const response: {
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    scope?: string;
  } = { accessToken };
  const refreshToken = readString(payload?.refresh_token);
  if (refreshToken.length > 0) {
    response.refreshToken = refreshToken;
  }

  const expiresIn = Number(payload?.expires_in);
  if (Number.isFinite(expiresIn)) {
    response.expiresIn = expiresIn;
  }

  const scope = readString(payload?.scope);
  if (scope.length > 0) {
    response.scope = scope;
  }

  return response;
}

function buildAuthorizeUrl({ auth, input }) {
  const url = new URL(oauthUrl(auth, "/oauth/authorize/"));
  url.searchParams.set("client_id", requireString(input.clientId, "clientId"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", requireString(input.redirectUri, "redirectUri"));
  url.searchParams.set("scope", readStringArray(input.scopes).join(" "));
  url.searchParams.set("state", requireString(input.state, "state"));
  url.searchParams.set(
    "code_challenge",
    requireString(input.codeChallenge, "codeChallenge"),
  );
  url.searchParams.set("code_challenge_method", "S256");

  return {
    status: 200,
    summary: "Built PostHog OAuth authorize URL.",
    data: {
      authUrl: url.toString(),
    },
  };
}

async function exchangeCodeForToken({ auth, input }) {
  const payload = new URLSearchParams({
    grant_type: "authorization_code",
    code: requireString(input.code, "code"),
    redirect_uri: requireString(input.redirectUri, "redirectUri"),
    code_verifier: requireString(input.codeVerifier, "codeVerifier"),
    client_id: requireString(input.clientId, "clientId"),
  });
  const clientSecret = readString(input.clientSecret);
  if (clientSecret.length > 0) {
    payload.set("client_secret", clientSecret);
  }

  const response = await requestPostHog(oauthUrl(auth, "/oauth/token/"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });

  return {
    status: 200,
    summary: "Exchanged PostHog OAuth code.",
    data: normalizeTokenResponse(await response.json()),
  };
}

async function refreshToken({ auth, input }) {
  const payload = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: requireString(input.refreshToken, "refreshToken"),
    client_id: requireString(input.clientId, "clientId"),
  });
  const clientSecret = readString(input.clientSecret);
  if (clientSecret.length > 0) {
    payload.set("client_secret", clientSecret);
  }

  const response = await requestPostHog(oauthUrl(auth, "/oauth/token/"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: payload.toString(),
  });

  return {
    status: 200,
    summary: "Refreshed PostHog OAuth token.",
    data: normalizeTokenResponse(await response.json()),
  };
}

function parsePaginatedResponse(payload) {
  const record = unknownRecord(payload);
  if (record === null) {
    return { results: [], next: null };
  }

  return {
    results: Array.isArray(record.results) ? record.results : [],
    next: typeof record.next === "string" ? record.next : null,
  };
}

function resolveSameOriginNextUrl(nextUrl, apiBase) {
  if (nextUrl === null || nextUrl.trim().length === 0) {
    return null;
  }

  const base = new URL(apiBase);
  const parsed = new URL(nextUrl, base);
  if (parsed.origin !== base.origin) {
    throw new Error("Refusing to follow cross-origin PostHog pagination URL");
  }

  return parsed.toString();
}

async function fetchAllPaginated(initialUrl, accessToken) {
  const out = [];
  let nextUrl = initialUrl;
  let pageCount = 0;

  while (nextUrl !== null) {
    if (pageCount >= 50) {
      throw new Error(
        "PostHog paginator exceeded 50 pages without exhausting results",
      );
    }
    pageCount += 1;

    const response = await requestPostHog(nextUrl, {
      headers: authHeaders(accessToken),
    });
    const parsed = parsePaginatedResponse(await response.json());
    for (const row of parsed.results) {
      out.push(row);
    }
    nextUrl = resolveSameOriginNextUrl(parsed.next, new URL(initialUrl).origin);
  }

  return out;
}

function quoteHogQLString(value) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function unwrapFencedMarkdownCode(value) {
  const fenced = value.match(/^```[^\n`]*\n?([\s\S]*?)\n?```$/);
  const body = fenced?.[1]?.trim();
  if (typeof body === "string" && body.length > 0) {
    return body;
  }

  return null;
}

function unwrapInlineMarkdownCode(value) {
  const inline = value.match(/^`([^`\n]+)`$/);
  const body = inline?.[1]?.trim();
  if (typeof body === "string" && body.length > 0) {
    return body;
  }

  return null;
}

function normalizeSearchQuery(value) {
  const trimmed = readString(value);
  return unwrapFencedMarkdownCode(trimmed) ?? unwrapInlineMarkdownCode(trimmed) ?? trimmed;
}

function padUtcComponent(value, length = 2) {
  return String(value).padStart(length, "0");
}

function quoteHogQLUtcDateTime64(value) {
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

function buildIssueWhereFilters(searchQuery) {
  const filters = ["event = '$exception'"];
  const query = normalizeSearchQuery(searchQuery);
  if (query.length === 0) {
    return filters;
  }

  const escaped = quoteHogQLString(`%${query}%`);
  filters.push(
    "(" +
      `properties.$exception_message ILIKE ${escaped} ` +
      `OR properties.$exception_type ILIKE ${escaped} ` +
      `OR properties.$exception_fingerprint ILIKE ${escaped} ` +
      `OR toString(properties.$exception_list) ILIKE ${escaped}` +
      ")",
  );
  return filters;
}

function buildHavingClause(input) {
  const filters = [];
  if (readString(input.since).length > 0) {
    filters.push(`max(timestamp) >= ${quoteHogQLUtcDateTime64(input.since)}`);
  }
  if (readString(input.until).length > 0) {
    filters.push(`max(timestamp) <= ${quoteHogQLUtcDateTime64(input.until)}`);
  }

  if (filters.length === 0) {
    return "";
  }

  return `HAVING ${filters.join(" AND ")}`;
}

function buildIssuesHogQL(input) {
  const offset = input.offset ?? 0;
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
    WHERE ${buildIssueWhereFilters(input.searchQuery).join(" AND ")}
    GROUP BY properties.$exception_fingerprint
    ${buildHavingClause(input)}
    ORDER BY last_seen DESC, fingerprint ASC
    LIMIT ${String(input.limit + 1)}
    OFFSET ${String(offset)}`;
}

function buildEventsHogQL(input) {
  const offset = input.offset ?? 0;
  const filters = [
    "event = '$exception'",
    `properties.$exception_fingerprint = ${quoteHogQLString(input.fingerprint)}`,
  ];
  if (readString(input.since).length > 0) {
    filters.push(`timestamp >= ${quoteHogQLUtcDateTime64(input.since)}`);
  }
  if (readString(input.until).length > 0) {
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

function parseHogQLResponse(payload) {
  const record = unknownRecord(payload) ?? {};
  return {
    columns: Array.isArray(record.columns)
      ? record.columns.filter((column) => typeof column === "string")
      : [],
    results: Array.isArray(record.results)
      ? record.results.filter((row) => Array.isArray(row))
      : [],
    hasMore: record.hasMore === true || record.has_more === true,
  };
}

function rowToObject(row, columns) {
  const out = {};
  for (let index = 0; index < columns.length; index += 1) {
    out[columns[index]] = row[index];
  }
  return out;
}

function toIsoOrNull(value) {
  const normalized = readString(value);
  if (normalized.length === 0) {
    return null;
  }

  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function toIsoOrNow(value) {
  return toIsoOrNull(value) ?? new Date().toISOString();
}

const POSTHOG_LEVELS = {
  critical: "fatal",
  fatal: "fatal",
  error: "error",
  warn: "warning",
  warning: "warning",
  info: "info",
  log: "info",
  debug: "debug",
};

function mapLevel(value) {
  const normalized = readString(value).toLowerCase();
  return POSTHOG_LEVELS[normalized] ?? "error";
}

function normalizeExceptionListEntries(exceptionList) {
  if (Array.isArray(exceptionList)) {
    return exceptionList.filter((item) => unknownRecord(item) !== null);
  }

  const record = unknownRecord(exceptionList);
  if (record !== null) {
    if (Array.isArray(record.values)) {
      return record.values.filter((item) => unknownRecord(item) !== null);
    }
    return [record];
  }

  if (typeof exceptionList === "string" && exceptionList.trim().length > 0) {
    try {
      return normalizeExceptionListEntries(JSON.parse(exceptionList));
    } catch {
      return [];
    }
  }

  return [];
}

function extractIssueTitlePartsFromExceptionList(exceptionList) {
  for (const record of normalizeExceptionListEntries(exceptionList)) {
    const exceptionType = pickFirstString(record.type);
    const message = pickFirstString(record.value, record.message);
    if (exceptionType !== null || message !== null) {
      return { exceptionType, message };
    }
  }

  return { exceptionType: null, message: null };
}

function optionalNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed)) {
    return parsed;
  }

  return null;
}

function addTag(tags, name, value) {
  if (value !== null) {
    tags.push([name, value]);
  }
}

function namespacedIssueId(projectId, fingerprint) {
  if (fingerprint.length === 0) {
    return "";
  }
  if (projectId !== null) {
    return `${projectId}:${fingerprint}`;
  }
  return fingerprint;
}

function issueTitle(exceptionType, message) {
  if (exceptionType !== null && message !== null) {
    return `${exceptionType}: ${message}`;
  }

  return message ?? exceptionType ?? "Untitled exception";
}

function buildIssueRecord(row) {
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
  const environment = pickFirstString(row.environment);
  const projectId = pickFirstString(row.project_id);
  const lib = pickFirstString(row.lib);
  const tags = [];
  addTag(tags, "environment", environment);
  addTag(tags, "project", projectId);
  addTag(tags, "library", lib);

  const eventCount = Number(row.event_count ?? row.count ?? 0);

  return {
    id: namespacedIssueId(projectId, fingerprint),
    fingerprint,
    shortId: fingerprint.length > 0 ? fingerprint.slice(0, 12) : null,
    title: issueTitle(exceptionType, message),
    message,
    exceptionType,
    culprit: null,
    type: exceptionType,
    level: mapLevel(row.level),
    status: "unresolved",
    firstSeen: toIsoOrNow(row.first_seen),
    lastSeen: toIsoOrNow(row.last_seen),
    count: eventCount,
    eventCount,
    userCount: optionalNumber(row.user_count),
    platform: lib,
    tags,
    project: projectId === null ? null : { slug: projectId },
    projectIdentifier: projectId,
    environment,
    metadata: row,
  };
}

function buildExceptionEntries(exceptionList, fallbackType, fallbackValue) {
  const entries = normalizeExceptionListEntries(exceptionList);
  if (entries.length > 0) {
    return [
      {
        type: "exception",
        data: {
          values: entries.map((item) => ({
            type: pickFirstString(item.type) ?? fallbackType,
            value: pickFirstString(item.value, item.message) ?? fallbackValue,
            stacktrace: unknownRecord(item.stacktrace),
            mechanism: unknownRecord(item.mechanism),
          })),
        },
      },
    ];
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

function addNamedContext(contexts, name, value) {
  if (value !== null) {
    contexts[name] = { name: value };
  }
}

function buildEventRecord(row) {
  const eventId = pickFirstString(row.uuid, row.id) ?? "";
  const exceptionType = pickFirstString(row.exception_type);
  const message = pickFirstString(row.message);
  const environment = pickFirstString(row.environment);
  const sessionId = pickFirstString(row.session_id);
  const currentUrl = pickFirstString(row.current_url);
  const browser = pickFirstString(row.browser);
  const os = pickFirstString(row.os);
  const lib = pickFirstString(row.lib);
  const personId = pickFirstString(row.person_id);
  const contexts: Record<string, unknown> = {};
  addNamedContext(contexts, "browser", browser);
  addNamedContext(contexts, "os", os);
  if (sessionId !== null) {
    contexts.session = { session_id: sessionId };
  }

  const tags = [];
  addTag(tags, "environment", environment);
  addTag(tags, "session_id", sessionId);
  addTag(tags, "library", lib);

  return {
    id: eventId,
    eventID: eventId,
    dateCreated: toIsoOrNow(row.timestamp),
    level: mapLevel(row.level),
    message,
    entries: buildExceptionEntries(row.exception_list, exceptionType, message),
    tags,
    contexts,
    user: personId === null ? null : { id: personId },
    request: currentUrl === null ? null : { url: currentUrl },
    environment,
    release: null,
    serverName: null,
    transaction: null,
    platform: lib,
  };
}

function decodeOffsetCursor(cursor) {
  const parsed = Number(readString(cursor));
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.trunc(parsed);
  }

  return 0;
}

function decodePerProjectCursor(cursor) {
  const raw = readString(cursor);
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed = unknownRecord(JSON.parse(raw));
    if (parsed === null) {
      return {};
    }

    const out = {};
    for (const [projectId, offset] of Object.entries(parsed)) {
      const numeric = Number(offset);
      if (Number.isFinite(numeric) && numeric >= 0) {
        out[projectId] = Math.trunc(numeric);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function issueLastSeenTimestamp(issue) {
  if (typeof issue.lastSeen !== "string") {
    return 0;
  }

  const timestamp = Date.parse(issue.lastSeen);
  if (Number.isFinite(timestamp)) {
    return timestamp;
  }

  return 0;
}

function mergeIssuesByRecency(perProjectResults, limit) {
  const tagged = [];
  const consumedByProject = new Map();
  const nextOffsets = {};
  let anyHasMore = false;

  for (const result of perProjectResults) {
    nextOffsets[result.projectId] = result.startOffset;
    for (const issue of result.issues) {
      tagged.push({ projectId: result.projectId, issue });
    }
  }

  tagged.sort((left, right) => {
    return (
      issueLastSeenTimestamp(right.issue) - issueLastSeenTimestamp(left.issue)
    );
  });

  const consumedSlice = tagged.slice(0, limit);
  for (const item of consumedSlice) {
    consumedByProject.set(
      item.projectId,
      (consumedByProject.get(item.projectId) ?? 0) + 1,
    );
  }

  for (const result of perProjectResults) {
    const consumed = consumedByProject.get(result.projectId) ?? 0;
    nextOffsets[result.projectId] = result.startOffset + consumed;
    if (consumed < result.issues.length || result.hasMore) {
      anyHasMore = true;
    }
  }

  return {
    issues: consumedSlice.map((item) => item.issue),
    hasMore: anyHasMore,
    nextCursor: anyHasMore ? JSON.stringify(nextOffsets) : undefined,
  };
}

function extractIssueFingerprint(issueId) {
  const colonIndex = issueId.indexOf(":");
  if (colonIndex < 0) {
    return { fingerprint: issueId };
  }

  return {
    projectId: issueId.slice(0, colonIndex),
    fingerprint: issueId.slice(colonIndex + 1),
  };
}

async function runHogQLQuery({ accessToken, apiBase, projectId, hogQL }) {
  const response = await requestPostHog(
    `${apiBase}/api/projects/${encodeURIComponent(projectId)}/query/`,
    {
      method: "POST",
      headers: {
        ...authHeaders(accessToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: { kind: "HogQLQuery", query: hogQL },
      }),
    },
  );

  return parseHogQLResponse(await response.json());
}

function limitRows(rows, limit) {
  if (rows.length > limit) {
    return rows.slice(0, limit);
  }

  return rows;
}

async function runIssuesQuery({
  accessToken,
  apiBase,
  projectId,
  searchQuery,
  since,
  until,
  limit,
  offset,
}) {
  const response = await runHogQLQuery({
    accessToken,
    apiBase,
    projectId,
    hogQL: buildIssuesHogQL({
      projectId,
      searchQuery,
      since,
      until,
      limit,
      offset,
    }),
  });

  const columns = response.columns;
  const rawRows = response.results;
  const overFetched = rawRows.length > limit;
  const issues = limitRows(rawRows, limit)
    .map((row) => buildIssueRecord(rowToObject(row, columns)))
    .filter((issue) => issue.id.length > 0);

  return {
    issues,
    hasMore: overFetched || response.hasMore,
  };
}

async function runEventsQuery({
  accessToken,
  apiBase,
  projectId,
  fingerprint,
  since,
  until,
  limit,
  offset,
}) {
  const response = await runHogQLQuery({
    accessToken,
    apiBase,
    projectId,
    hogQL: buildEventsHogQL({
      projectId,
      fingerprint,
      since,
      until,
      limit,
      offset,
    }),
  });

  const columns = response.columns;
  const rawRows = response.results;
  const overFetched = rawRows.length > limit;
  const events = limitRows(rawRows, limit)
    .map((row) => buildEventRecord(rowToObject(row, columns)))
    .filter((event) => event.id.length > 0);

  return {
    events,
    hasMore: overFetched || response.hasMore,
  };
}

async function listOrganizations({ auth }) {
  const accessToken = requireString(auth.accessToken, "accessToken");
  const apiBase = readApiBase(auth);
  const rows = await fetchAllPaginated(`${apiBase}/api/organizations/`, accessToken);
  const organizations = rows.map((item) => {
    const record = unknownRecord(item) ?? {};
    const slug = readString(record.id, readString(record.slug));
    return {
      slug,
      name: readString(record.name, readString(record.slug, slug)),
    };
  });

  return {
    status: 200,
    summary: `Fetched ${String(organizations.length)} PostHog organizations.`,
    data: organizations,
  };
}

async function listProjects({ auth, input }) {
  const accessToken = requireString(auth.accessToken, "accessToken");
  const apiBase = readApiBase(auth);
  const url = new URL(`${apiBase}/api/projects/`);
  const orgSlug = readString(input.orgSlug);
  if (orgSlug.length > 0) {
    url.searchParams.set("organization_id", orgSlug);
  }

  const rows = await fetchAllPaginated(url.toString(), accessToken);
  const projects = rows.map((item) => {
    const record = unknownRecord(item) ?? {};
    const id = readString(record.id);
    return {
      id,
      slug: id,
      name: readString(record.name, id),
      organizationId: readString(record.organization),
    };
  });

  return {
    status: 200,
    summary: `Fetched ${String(projects.length)} PostHog projects.`,
    data: projects,
  };
}

async function getProject({ auth, input }) {
  const accessToken = requireString(auth.accessToken, "accessToken");
  const projectId = requireString(input.projectId, "projectId");
  const apiBase = readApiBase(auth);
  const response = await requestPostHog(
    `${apiBase}/api/projects/${encodeURIComponent(projectId)}/`,
    {
      headers: authHeaders(accessToken),
    },
  );
  const record = unknownRecord(await response.json()) ?? {};
  const id = readString(record.id, projectId);

  return {
    status: 200,
    summary: `Fetched PostHog project ${id}.`,
    data: {
      id,
      slug: id,
      name: readString(record.name, id),
      organizationId: readString(record.organization),
    },
  };
}

async function queryIssues({ auth, input }) {
  return queryProjectIssues({
    auth,
    input: {
      ...input,
      searchQuery: normalizeSearchQuery(input.query),
    },
  });
}

async function listIssues({ auth, input }) {
  return queryProjectIssues({
    auth,
    input: {
      ...input,
      searchQuery: "",
    },
  });
}

async function queryProjectIssues({ auth, input }) {
  const accessToken = requireString(auth.accessToken, "accessToken");
  const apiBase = readApiBase(auth);
  const projectIds = readStringArray(input.projectIds);
  const limit = boundedLimit(input.limit, DEFAULT_ISSUES_LIMIT);
  if (projectIds.length === 0) {
    return {
      status: 200,
      summary: "Fetched 0 PostHog issues.",
      data: { issues: [], hasMore: false },
    };
  }

  const offsets = decodePerProjectCursor(input.cursor);
  const perProjectResults = await Promise.all(
    projectIds.map(async (projectId) => {
      const startOffset = offsets[projectId] ?? 0;
      const result = await runIssuesQuery({
        accessToken,
        apiBase,
        projectId,
        searchQuery: input.searchQuery,
        since: input.since,
        until: input.until,
        limit,
        offset: startOffset,
      });
      return { projectId, startOffset, ...result };
    }),
  );
  const merged = mergeIssuesByRecency(perProjectResults, limit);

  return {
    status: 200,
    summary: `Fetched ${String(merged.issues.length)} PostHog issues.`,
    data: merged,
  };
}

async function listIssueEvents({ auth, input }) {
  const accessToken = requireString(auth.accessToken, "accessToken");
  const apiBase = readApiBase(auth);
  const issueId = requireString(input.issueId, "issueId");
  const limit = boundedLimit(input.limit, DEFAULT_EVENTS_LIMIT);
  const offset = decodeOffsetCursor(input.cursor);
  const { projectId: scopedProjectId, fingerprint } =
    extractIssueFingerprint(issueId);
  let projectIds = readStringArray(input.projectIds);
  if (scopedProjectId !== undefined && scopedProjectId.length > 0) {
    projectIds = [scopedProjectId];
  }

  const events = [];
  let hasMore = false;
  for (const projectId of projectIds) {
    const result = await runEventsQuery({
      accessToken,
      apiBase,
      projectId,
      fingerprint,
      since: input.since,
      until: input.until,
      limit,
      offset,
    });
    for (const event of result.events) {
      events.push(event);
    }
    hasMore = hasMore || result.hasMore;
  }

  return {
    status: 200,
    summary: `Fetched ${String(events.length)} PostHog events.`,
    data: {
      events,
      hasMore,
      nextCursor: hasMore ? String(offset + limit) : undefined,
    },
  };
}

const plugin: DesktopCodePlugin = {
  id: "posthog",
  name: "PostHog",
  version: "0.1.0",
  description: "Queries PostHog organizations, projects, exception issues, and events.",
  metadata: {
    errorSource: {
      sourceType: "posthog",
      setupFields: [
        {
          key: "authToken",
          label: "PostHog personal API key",
          required: true,
          control: "password",
        },
        {
          key: "baseUrl",
          label: "PostHog base URL",
          placeholder: POSTHOG_DEFAULT_BASE_URL,
          required: false,
          control: "text",
        },
        {
          key: "orgSlug",
          label: "Organization ID",
          required: false,
          control: "text",
        },
        {
          key: "projectIds",
          label: "Project IDs",
          placeholder: "177710\n177711",
          required: false,
          control: "multiline_list",
        },
      ],
      oauth: {
        envClientIdName: "POSTHOG_OAUTH_CLIENT_ID",
        envClientSecretName: "POSTHOG_OAUTH_CLIENT_SECRET",
        envRedirectUriName: "POSTHOG_OAUTH_REDIRECT_URI",
        defaultRedirectUri: "http://127.0.0.1:48174/oauth/posthog/callback",
        scopes: ["organization:read", "project:read", "query:read"],
        publicClient: true,
      },
    },
  },
  errorSource: {
    resolveSetup: resolvePostHogErrorSourceSetup,
    buildAuth: buildPostHogErrorSourceAuth,
    buildProbeAuth: buildPostHogErrorSourceProbeAuth,
  },
  auth: {
    fields: [
      {
        key: "accessToken",
        label: "PostHog personal API key",
        type: "string",
        required: false,
        secret: true,
      },
      {
        key: "baseUrl",
        label: "PostHog base URL",
        type: "string",
        required: false,
        defaultValue: POSTHOG_DEFAULT_BASE_URL,
      },
    ],
  },
  actions: [
    {
      id: "build_authorize_url",
      title: "Build PostHog OAuth authorize URL",
      description: "Build the PostHog OAuth PKCE authorize URL.",
      riskLevel: "read",
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          type: "string",
          required: true,
        },
        {
          key: "redirectUri",
          label: "Redirect URI",
          type: "string",
          required: true,
        },
        {
          key: "scopes",
          label: "Scopes",
          type: "string_array",
          required: false,
          defaultValue: [],
        },
        {
          key: "state",
          label: "State",
          type: "string",
          required: true,
        },
        {
          key: "codeChallenge",
          label: "Code challenge",
          type: "string",
          required: true,
        },
      ],
      execute: buildAuthorizeUrl,
    },
    {
      id: "exchange_code_for_token",
      title: "Exchange PostHog OAuth code",
      description: "Exchange a PostHog OAuth authorization code for tokens.",
      riskLevel: "read",
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          type: "string",
          required: true,
        },
        {
          key: "clientSecret",
          label: "Client secret",
          type: "string",
          required: false,
          defaultValue: "",
          secret: true,
        },
        {
          key: "code",
          label: "Code",
          type: "string",
          required: true,
        },
        {
          key: "redirectUri",
          label: "Redirect URI",
          type: "string",
          required: true,
        },
        {
          key: "codeVerifier",
          label: "Code verifier",
          type: "string",
          required: true,
          secret: true,
        },
      ],
      execute: exchangeCodeForToken,
    },
    {
      id: "refresh_token",
      title: "Refresh PostHog OAuth token",
      description: "Refresh a PostHog OAuth access token.",
      riskLevel: "read",
      fields: [
        {
          key: "clientId",
          label: "Client ID",
          type: "string",
          required: true,
        },
        {
          key: "clientSecret",
          label: "Client secret",
          type: "string",
          required: false,
          defaultValue: "",
          secret: true,
        },
        {
          key: "refreshToken",
          label: "Refresh token",
          type: "string",
          required: true,
          secret: true,
        },
      ],
      execute: refreshToken,
    },
    {
      id: "list_organizations",
      title: "List PostHog organizations",
      description: "List organizations accessible to a PostHog token.",
      riskLevel: "read",
      fields: [],
      execute: listOrganizations,
    },
    {
      id: "list_projects",
      title: "List PostHog projects",
      description: "List PostHog projects, optionally scoped to an organization.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
      ],
      execute: listProjects,
    },
    {
      id: "get_project",
      title: "Get PostHog project",
      description: "Fetch one PostHog project by project ID.",
      riskLevel: "read",
      fields: [
        {
          key: "projectId",
          label: "Project ID",
          type: "string",
          required: true,
        },
      ],
      execute: getProject,
    },
    {
      id: "query_issues",
      title: "Query PostHog exception issues",
      description: "Search exception fingerprints with HogQL.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        {
          key: "projectIds",
          label: "Project IDs",
          type: "string_array",
          required: false,
          defaultValue: [],
        },
        {
          key: "query",
          label: "Search query",
          type: "string",
          required: false,
          defaultValue: "",
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: DEFAULT_ISSUES_LIMIT,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
      ],
      execute: queryIssues,
    },
    {
      id: "list_issues",
      title: "List PostHog exception issues",
      description: "List exception fingerprints bounded by last-seen timestamps.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        {
          key: "projectIds",
          label: "Project IDs",
          type: "string_array",
          required: false,
          defaultValue: [],
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: DEFAULT_ISSUES_LIMIT,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
        {
          key: "since",
          label: "Since",
          type: "string",
          required: false,
        },
        {
          key: "until",
          label: "Until",
          type: "string",
          required: false,
        },
      ],
      execute: listIssues,
    },
    {
      id: "list_issue_events",
      title: "List PostHog issue events",
      description: "List exception events for one fingerprint.",
      riskLevel: "read",
      fields: [
        {
          key: "orgSlug",
          label: "Organization ID",
          type: "string",
          required: false,
        },
        {
          key: "issueId",
          label: "Issue ID",
          type: "string",
          required: true,
        },
        {
          key: "projectIds",
          label: "Project IDs",
          type: "string_array",
          required: false,
          defaultValue: [],
        },
        {
          key: "limit",
          label: "Limit",
          type: "number",
          required: false,
          defaultValue: DEFAULT_EVENTS_LIMIT,
        },
        {
          key: "cursor",
          label: "Cursor",
          type: "string",
          required: false,
        },
        {
          key: "since",
          label: "Since",
          type: "string",
          required: false,
        },
        {
          key: "until",
          label: "Until",
          type: "string",
          required: false,
        },
      ],
      execute: listIssueEvents,
    },
  ],
};

export { plugin };
export default plugin;
