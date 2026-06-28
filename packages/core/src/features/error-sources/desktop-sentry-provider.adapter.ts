import {
  type ErrorSourceProvider,
  type OAuthAuthorizeInput,
  type OAuthTokenExchangeInput,
  type OAuthTokenRefreshInput,
  type OAuthTokenResponse,
  type IssueBatchResponse,
  type EventBatchResponse,
} from './desktop-error-source-provider.interface'
import { z } from 'zod'

const SENTRY_AUTHORIZE_URL = 'https://sentry.io/oauth/authorize/'
const SENTRY_TOKEN_URL = 'https://sentry.io/oauth/token/'
const SENTRY_API_BASE = 'https://sentry.io/api/0'
const DEFAULT_ISSUES_LIMIT = 50
const MAX_ISSUES_LIMIT = 100

const sentryTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.union([z.number(), z.string()]).nullish(),
})

const sentryOrganizationSchema = z.object({
  slug: z.string(),
  name: z.string().optional(),
})

const sentryProjectSchema = z.object({
  id: z.union([z.string(), z.number()]),
  slug: z.string(),
  name: z.string().optional(),
})

const sentryRecordArraySchema = z.array(z.record(z.string(), z.unknown()))

function parseSentryArray<T>(payload: unknown, schema: z.ZodType<T>): T[] {
  const parsed = z.array(schema).safeParse(payload)
  if (parsed.success) {
    return parsed.data
  }

  return []
}

function getQuotedLinkValue(segment: string, key: string): string | undefined {
  const match = segment.match(new RegExp(`${key}="([^"]+)"`, 'i'))
  const value = match?.[1]
  if (value !== undefined && value.length > 0) {
    return value
  }

  return undefined
}

function parseCursorFromLinkUrl(segment: string, hasMore: boolean): { nextCursor?: string; hasMore: boolean } {
  const urlMatch = segment.match(/<([^>]+)>/)
  const url = urlMatch?.[1]
  if (url === undefined || url.length === 0) {
    return { hasMore }
  }

  try {
    const parsed = new URL(url)
    return withOptionalNextCursor(parsed.searchParams.get('cursor'), hasMore)
  } catch {
    return { hasMore }
  }
}

function parseCursorFromLinkSegment(segment: string): { nextCursor?: string; hasMore: boolean } {
  const hasMore = getQuotedLinkValue(segment, 'results')?.toLowerCase() === 'true'

  const cursor = getQuotedLinkValue(segment, 'cursor')
  if (cursor !== undefined) {
    return { nextCursor: cursor, hasMore }
  }

  return parseCursorFromLinkUrl(segment, hasMore)
}

function parseNextCursor(linkHeader: string | null): { nextCursor?: string; hasMore: boolean } {
  if (linkHeader === null || linkHeader.length === 0) {
    return { hasMore: false }
  }

  const segments = linkHeader.split(',').map((part) => part.trim())
  for (const segment of segments) {
    if (!/rel="next"/i.test(segment)) continue

    return parseCursorFromLinkSegment(segment)
  }

  return { hasMore: false }
}

function withOptionalNextCursor(
  cursor: string | null,
  hasMore: boolean,
): { nextCursor?: string; hasMore: boolean } {
  if (cursor !== null && cursor.length > 0) {
    return { nextCursor: cursor, hasMore }
  }

  return { hasMore }
}

function parseErrorBody(raw: string | null): string {
  if (raw === null || raw.length === 0) {
    return 'Unknown Sentry API error'
  }
  try {
    const parsed = JSON.parse(raw) as { detail?: string; error?: string }
    if (typeof parsed.detail === 'string' && parsed.detail.trim().length > 0) {
      return parsed.detail
    }
    if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error
    }
  } catch {
    // fallthrough
  }
  return raw.slice(0, 300)
}

function normalizeTokenResponse(payload: unknown): OAuthTokenResponse {
  const parsed = sentryTokenResponseSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error('Sentry OAuth response did not include an access token')
  }

  const accessToken = parsed.data.access_token.trim()
  const response: OAuthTokenResponse = {
    accessToken,
  }

  addOptionalTokenResponseFields(response, parsed.data)
  return response
}

function addOptionalTokenResponseFields(
  response: OAuthTokenResponse,
  data: z.infer<typeof sentryTokenResponseSchema>,
): void {
  const refreshToken = data.refresh_token?.trim() ?? ''
  if (refreshToken.length > 0) {
    response.refreshToken = refreshToken
  }

  const expiresIn = normalizeExpiresIn(data.expires_in)
  if (expiresIn !== undefined) {
    response.expiresIn = expiresIn
  }

  const scope = data.scope?.trim() ?? ''
  if (scope.length > 0) {
    response.scope = scope
  }
}

function normalizeExpiresIn(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined

  const expiresIn = Number(value)
  if (Number.isFinite(expiresIn)) {
    return expiresIn
  }

  return undefined
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return String(error)
}

function parseSentryRecordArray(payload: unknown): Array<Record<string, unknown>> {
  const parsed = sentryRecordArraySchema.safeParse(payload)
  if (parsed.success) {
    return parsed.data
  }

  return []
}

export class SentryProviderAdapter implements ErrorSourceProvider {
  readonly sourceType = 'sentry' as const

  buildAuthorizeUrl(input: OAuthAuthorizeInput): string {
    const url = new URL(SENTRY_AUTHORIZE_URL)
    url.searchParams.set('client_id', input.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', input.redirectUri)
    url.searchParams.set('scope', input.scopes.join(' '))
    url.searchParams.set('state', input.state)
    url.searchParams.set('code_challenge', input.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
  }

  async exchangeCodeForToken(input: OAuthTokenExchangeInput): Promise<OAuthTokenResponse> {
    const payload = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    })

    const response = await this.requestWithRetry(SENTRY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload.toString(),
      signal: input.signal,
    })

    const parsed = (await response.json()) as unknown
    return normalizeTokenResponse(parsed)
  }

  async refreshToken(input: OAuthTokenRefreshInput): Promise<OAuthTokenResponse> {
    const payload = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    })

    const response = await this.requestWithRetry(SENTRY_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload.toString(),
      signal: input.signal,
    })

    const parsed = (await response.json()) as unknown
    return normalizeTokenResponse(parsed)
  }

  async listOrganizations(accessToken: string): Promise<Array<{ slug: string; name: string }>> {
    const response = await this.requestWithRetry(`${SENTRY_API_BASE}/organizations/`, {
      headers: this.authHeaders(accessToken),
    })
    const parsed = parseSentryArray(await response.json(), sentryOrganizationSchema)
    return parsed.map((item) => ({
      slug: item.slug,
      name: item.name ?? item.slug,
    }))
  }

  async listProjects(input: {
    accessToken: string
    orgSlug: string
    signal?: AbortSignal
  }): Promise<Array<{ id: string; slug: string; name: string }>> {
    const response = await this.requestWithRetry(
      `${SENTRY_API_BASE}/organizations/${encodeURIComponent(input.orgSlug)}/projects/`,
      {
        headers: this.authHeaders(input.accessToken),
        signal: input.signal,
      },
    )

    const parsed = parseSentryArray(await response.json(), sentryProjectSchema)
    return parsed.map((item) => ({
      id: String(item.id),
      slug: item.slug,
      name: item.name ?? item.slug,
    }))
  }

  async queryIssues(input: {
    accessToken: string
    orgSlug: string
    projectIds: string[]
    query: string
    limit?: number
    cursor?: string
    signal?: AbortSignal
  }): Promise<IssueBatchResponse> {
    const url = this.buildIssuesUrl({
      orgSlug: input.orgSlug,
      projectIds: input.projectIds,
      cursor: input.cursor,
      limit: input.limit,
      query: input.query,
    })

    const response = await this.requestWithRetry(url.toString(), {
      headers: this.authHeaders(input.accessToken),
      signal: input.signal,
    })

    const issues = parseSentryRecordArray(await response.json())
    const page = parseNextCursor(response.headers.get('link'))
    return {
      issues,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  async listIssues(input: {
    accessToken: string
    orgSlug: string
    projectIds: string[]
    cursor?: string
    limit?: number
    since?: string
    until?: string
  }): Promise<IssueBatchResponse> {
    const url = this.buildIssuesUrl({
      orgSlug: input.orgSlug,
      projectIds: input.projectIds,
      cursor: input.cursor,
      limit: input.limit,
      query: this.buildLastSeenQuery(input.since, input.until),
    })

    const response = await this.requestWithRetry(url.toString(), {
      headers: this.authHeaders(input.accessToken),
    })

    const issues = parseSentryRecordArray(await response.json())
    const page = parseNextCursor(response.headers.get('link'))
    return {
      issues,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  async listIssueEvents(input: {
    accessToken: string
    orgSlug: string
    issueId: string
    cursor?: string
    since?: string
    until?: string
  }): Promise<EventBatchResponse> {
    const url = new URL(
      `${SENTRY_API_BASE}/organizations/${encodeURIComponent(input.orgSlug)}/issues/${encodeURIComponent(input.issueId)}/events/`,
    )
    url.searchParams.set('limit', '50')
    if (input.cursor !== undefined && input.cursor.length > 0) {
      url.searchParams.set('cursor', input.cursor)
    }
    if (input.since !== undefined && input.since.length > 0) {
      url.searchParams.set('start', input.since)
    }
    if (input.until !== undefined && input.until.length > 0) {
      url.searchParams.set('end', input.until)
    }

    const response = await this.requestWithRetry(url.toString(), {
      headers: this.authHeaders(input.accessToken),
    })

    const events = parseSentryRecordArray(await response.json())
    const page = parseNextCursor(response.headers.get('link'))
    return {
      events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    }
  }

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    }
  }

  private buildIssuesUrl(input: {
    orgSlug: string
    projectIds: string[]
    cursor?: string
    limit?: number
    query?: string
  }): URL {
    const url = new URL(
      `${SENTRY_API_BASE}/organizations/${encodeURIComponent(input.orgSlug)}/issues/`,
    )
    const limit = this.getIssuesLimit(input.limit)
    url.searchParams.set('limit', String(limit))
    if (input.cursor !== undefined && input.cursor.length > 0) {
      url.searchParams.set('cursor', input.cursor)
    }

    for (const projectId of input.projectIds) {
      if (/^\d+$/.test(projectId)) {
        url.searchParams.append('project', projectId)
      }
    }

    if (input.query !== undefined && input.query.trim().length > 0) {
      url.searchParams.set('query', input.query.trim())
    }

    return url
  }

  private buildLastSeenQuery(
    since: string | undefined,
    until: string | undefined,
  ): string | undefined {
    const clauses = [
      since !== undefined && since.length > 0 ? `lastSeen:>=${since}` : undefined,
      until !== undefined && until.length > 0 ? `lastSeen:<=${until}` : undefined,
    ].filter((clause): clause is string => clause !== undefined)

    if (clauses.length === 0) {
      return undefined
    }

    return clauses.join(' ')
  }

  private getIssuesLimit(limit: number | undefined): number {
    if (limit !== undefined && Number.isFinite(limit)) {
      return Math.max(1, Math.min(MAX_ISSUES_LIMIT, Math.trunc(limit)))
    }

    return DEFAULT_ISSUES_LIMIT
  }

  private async requestWithRetry(
    url: string,
    init: RequestInit,
    maxAttempts = 5,
  ): Promise<Response> {
    let attempt = 0
    let delayMs = 1_000

    while (attempt < maxAttempts) {
      attempt += 1
      let response: Response
      try {
        response = await this.fetchWithTimeout(url, init)
      } catch (error) {
        delayMs = await this.handleFetchRetry(error, attempt, maxAttempts, delayMs, init.signal)
        continue
      }

      if (response.ok) {
        return response
      }

      if (!this.shouldRetryResponse(response, attempt, maxAttempts)) {
        await this.throwResponseError(response)
      }

      delayMs = await this.waitForResponseRetry(response, delayMs, init.signal)
    }

    throw new Error('Sentry API request failed after retries')
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: this.withRequestTimeout(init.signal),
    })
  }

  private async handleFetchRetry(
    error: unknown,
    attempt: number,
    maxAttempts: number,
    delayMs: number,
    signal: AbortSignal | null | undefined,
  ): Promise<number> {
    if (this.isAbortSignalAborted(signal)) {
      throw new Error('Sentry API request cancelled')
    }
    if (attempt >= maxAttempts) {
      throw new Error(`Sentry API request failed: ${toErrorMessage(error)}`)
    }

    await this.waitForRetry(delayMs, signal)
    return this.nextBackoffDelay(delayMs)
  }

  private shouldRetryResponse(
    response: Response,
    attempt: number,
    maxAttempts: number,
  ): boolean {
    const status = response.status
    return (status === 429 || status >= 500) && attempt < maxAttempts
  }

  private async throwResponseError(response: Response): Promise<never> {
    const body = await response.text().catch(() => '')
    throw new Error(`Sentry API ${String(response.status)}: ${parseErrorBody(body)}`)
  }

  private async waitForResponseRetry(
    response: Response,
    delayMs: number,
    signal: AbortSignal | null | undefined,
  ): Promise<number> {
    const retryAfterHeader = response.headers.get('retry-after')
    const nextDelay = this.getRetryDelay(delayMs, retryAfterHeader)
    await this.waitForRetry(nextDelay, signal)
    return this.nextBackoffDelay(delayMs)
  }

  private nextBackoffDelay(delayMs: number): number {
    return Math.min(delayMs * 2, 30_000)
  }

  private withRequestTimeout(signal: AbortSignal | null | undefined): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(30_000)
    if (signal !== null && signal !== undefined) {
      return AbortSignal.any([signal, timeoutSignal])
    }

    return timeoutSignal
  }

  private isAbortSignalAborted(signal: AbortSignal | null | undefined): boolean {
    return signal?.aborted === true
  }

  private async waitForRetry(
    delayMs: number,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    if (signal === null || signal === undefined) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return
    }
    if (signal.aborted) {
      throw new Error('Sentry API request cancelled')
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', handleAbort)
        resolve()
      }, delayMs)
      const handleAbort = () => {
        clearTimeout(timeout)
        reject(new Error('Sentry API request cancelled'))
      }
      signal.addEventListener('abort', handleAbort, { once: true })
    })
  }

  private getRetryDelay(delayMs: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader === null || retryAfterHeader.length === 0) {
      return delayMs
    }

    const retryAfterSeconds = Number(retryAfterHeader)
    if (Number.isFinite(retryAfterSeconds)) {
      return Math.max(500, retryAfterSeconds * 1_000)
    }

    return delayMs
  }
}
