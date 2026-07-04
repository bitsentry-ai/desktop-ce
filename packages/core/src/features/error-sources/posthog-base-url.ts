/**
 * SSRF-safety helpers for PostHog base URLs. Shared by the desktop, backend,
 * and worker consumers so a single allowlist policy gates every outbound
 * request — initial probe, OAuth, sync, runbook execution, and pagination
 * follow-ups.
 *
 * The function throws plain `Error`s with stable messages; consumers wrap
 * them in their framework's HTTP-shaped error type (NestJS
 * `BadRequestException`, Encore `APIError.invalidArgument`, etc.).
 *
 * Pure / framework-free: no imports beyond the runtime. Safe for desktop
 * main, NestJS, Encore, and browser code paths.
 */

const POSTHOG_DEFAULT_BASE_URL = "https://us.posthog.com";

/**
 * The two PostHog cloud regions are always allowed. Self-hosted deployments
 * opt in by passing additional hosts at the call site.
 */
export const POSTHOG_BUILTIN_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "us.posthog.com",
  "eu.posthog.com",
]);

export interface PostHogAllowlistOptions {
  /**
   * Extra hosts that should be allowed on top of the two built-in PostHog
   * cloud regions. Comes from `POSTHOG_ALLOWED_BASE_URLS` env var on the
   * server, an opt-in list on the desktop, etc.
   */
  extraAllowedHosts?: Iterable<string> | null;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAllowedHostEntry(value: string): string | null {
  const normalized = normalizeHost(value);
  if (normalized.length === 0) return null;

  if (!normalized.includes("://")) {
    return normalized;
  }

  try {
    const host = normalizeHost(new URL(normalized).host);
    if (host.length > 0) {
      return host;
    }

    return null;
  } catch {
    return normalized;
  }
}

/**
 * Parse a comma-separated allowlist env var into a `Set` of lowercased hosts.
 * Each entry may be a host (`grafana.example.com`) or a full URL — the host
 * is extracted in either case. Empty entries are skipped.
 */
export function parsePostHogAllowedHostsEnv(
  raw: string | undefined,
): ReadonlySet<string> {
  if (raw === undefined || raw.length === 0) return new Set<string>();
  const hosts = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const host = normalizeAllowedHostEntry(trimmed);
    if (host !== null) {
      hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Validate a user-supplied PostHog base URL and return a canonical
 * `https://host[:port]` form (no trailing slash, no path/query) suitable for
 * concatenating `/api/...` paths.
 *
 * Throws when the URL is unparseable, non-HTTPS, or its host is outside the
 * built-in + caller-supplied allowlist. Empty input returns the default
 * `us.posthog.com` so the rest of the codebase can keep its
 * "missing baseUrl ⇒ US cloud" contract.
 */
export function assertAllowedPostHogBaseUrl(
  baseUrl: string | null | undefined,
  options: PostHogAllowlistOptions = {},
): string {
  const normalized = normalizedOptionalUrl(baseUrl);
  if (normalized === undefined) {
    return POSTHOG_DEFAULT_BASE_URL;
  }

  const parsed = parseRequiredUrl(normalized, "Invalid PostHog base URL");
  assertHttpsPostHogUrl(parsed);

  const host = normalizeHost(parsed.host);
  if (host.length === 0) {
    throw new Error(`Invalid PostHog base URL: "${normalized}"`);
  }

  const extra = normalizeExtraAllowedHosts(options.extraAllowedHosts);
  if (!POSTHOG_BUILTIN_ALLOWED_HOSTS.has(host) && !extra.has(host)) {
    throw new Error(
      `PostHog base URL "${host}" is not in the allowlist. Set POSTHOG_ALLOWED_BASE_URLS to whitelist self-hosted instances.`,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function normalizedOptionalUrl(
  value: string | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized;
}

function parseRequiredUrl(value: string, messagePrefix: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${messagePrefix}: "${value}"`);
  }
}

function assertHttpsPostHogUrl(parsed: URL): void {
  if (parsed.protocol !== "https:") {
    throw new Error("PostHog base URL must use https://");
  }
}

function normalizeExtraAllowedHosts(
  extraAllowedHosts: Iterable<string> | null | undefined,
): Set<string> {
  const hosts = new Set<string>();
  if (extraAllowedHosts === null || extraAllowedHosts === undefined)
    return hosts;

  for (const entry of extraAllowedHosts) {
    const candidate = normalizeAllowedHostEntry(entry);
    if (candidate !== null) hosts.add(candidate);
  }

  return hosts;
}

function safeParseUrl(value: string | null | undefined): URL | null {
  const normalized = normalizedOptionalUrl(value);
  if (normalized === undefined) return null;
  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

/**
 * Resolve an upstream-supplied `next` URL (PostHog DRF pagination) against
 * the originating base. The return value is the same-origin absolute URL
 * string; `null` is returned when there is no next page. Throws if the
 * `next` URL points at a different origin, which would otherwise let an
 * upstream response redirect our bearer token to an attacker host.
 *
 * Why this exists: PostHog's API responses include a `next` field with a
 * fully-qualified URL. Following it verbatim trusts the upstream JSON to
 * dictate where to send the next request — and with a Bearer token attached
 * that is a cross-origin credential leak primitive on top of SSRF.
 */
export function resolveSameOriginNextUrl(
  nextUrl: string | null | undefined,
  baseUrl: string,
): string | null {
  const trimmed = normalizedOptionalUrl(nextUrl);
  if (trimmed === undefined) return null;
  const baseParsed = safeParseUrl(baseUrl);
  if (baseParsed === null) {
    throw new Error(`Cannot resolve next URL: base "${baseUrl}" is not a URL`);
  }
  let nextParsed: URL;
  try {
    nextParsed = new URL(trimmed, baseParsed);
  } catch {
    throw new Error(`Cannot resolve next URL: "${trimmed}" is not a URL`);
  }
  if (nextParsed.origin !== baseParsed.origin) {
    throw new Error(
      `Refusing to follow cross-origin PostHog pagination URL: "${nextParsed.origin}" != "${baseParsed.origin}"`,
    );
  }
  return nextParsed.toString();
}
