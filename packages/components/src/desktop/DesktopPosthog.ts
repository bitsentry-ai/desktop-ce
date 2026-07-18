type DesktopPosthogClient = {
  init: (apiKey: string, options: Record<string, unknown>) => void
  identify: (distinctId: string, properties?: Record<string, unknown>) => void
  capture: (event: string, properties?: Record<string, unknown>) => void
  captureException?: (error: unknown) => void
}

export type DesktopAnalyticsUser = {
  id: number | string
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  totpEnabled?: boolean
}

export type DesktopPosthogApi = {
  initDesktopAnalytics: () => Promise<void>
  syncDesktopAnalyticsUser: (user: DesktopAnalyticsUser | null) => void
  captureDesktopAnalyticsEvent: (
    event: string,
    properties?: Record<string, unknown>,
  ) => void
  captureDesktopAnalyticsException: (error: unknown) => void
  captureDesktopPageview: (path: string) => void
}

type ConfigureDesktopPosthogRuntimeInput = {
  posthogClient: DesktopPosthogClient
  posthogKey?: string
  posthogHost?: string
  productName?: string
}

function envString(value: string | undefined, fallback = ''): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length > 0) {
    return trimmed
  }

  return fallback
}

let configuredPosthogClient: DesktopPosthogClient | null = null
let POSTHOG_KEY = ''
let POSTHOG_HOST = 'https://us.i.posthog.com'
let PRODUCT_NAME = 'superterminal'
const LAST_APP_OPENED_AT_KEY = 'bitsentry.analytics.lastAppOpenedAt'

type DesktopAnalyticsContext = {
  installationId: string | null
  telemetryEnabled: boolean
  shouldCaptureFirstRun: boolean
  appVersion: string
  releaseChannel: string
  platform: string
}

type DesktopAnalyticsBridge = {
  analytics: {
    getContext: () => Promise<DesktopAnalyticsContext>
    markFirstRunCaptured: () => Promise<{ ok: boolean }>
  }
}

type PendingEvent = {
  event: string
  properties?: Record<string, unknown>
}

type AnalyticsEventEnvelope = {
  event: string
  properties?: Record<string, unknown>
}

const SIMPLE_BETA_EVENTS = new Map<string, string>([
  ['desktop_first_run', 'onboarding_started'],
  ['desktop_runbook_created', 'runbook_created'],
  ['desktop_runbook_action_saved', 'runbook_step_added'],
  ['desktop_runbook_actions_reordered', 'runbook_edited'],
  ['desktop_runbook_action_deleted', 'runbook_edited'],
  ['desktop_runbook_import_flow_started', 'runbook_import_started'],
])

const DESKTOP_ACTION_SUCCESS_EVENTS = new Map<string, string[]>([
  ['agent:start', ['session_created']],
  ['runbooks:execute', ['runbook_run_started']],
  ['runbooks:export', ['session_exported']],
  ['runbooks:exportToFile', ['session_exported']],
  ['runbooks:import', ['runbook_imported']],
  ['runbooks:importFromFile', ['runbook_imported']],
  [
    'errorSources:create',
    ['connection_attempted', 'source_created', 'connection_succeeded'],
  ],
  ['errorSources:testConnection', ['connection_attempted', 'connection_succeeded']],
  ['errorSources:triggerSync', ['source_sync_started']],
  ['settings:updateGeneral', ['settings_updated']],
  ['settings:updateSecurity', ['settings_updated']],
  ['settings:updateNotifications', ['settings_updated']],
])

let initialized = false
let initPromise: Promise<void> | null = null
let analyticsContext: DesktopAnalyticsContext | null = null
let telemetryEnabled: boolean | null = null
const pendingEvents: PendingEvent[] = []
const pendingExceptions: unknown[] = []
let lastIdentifyFingerprint: string | null = null
let pendingIdentifyUser: DesktopAnalyticsUser | null = null

function getPosthogClient(): DesktopPosthogClient | null {
  return configuredPosthogClient
}

function getDesktopAnalyticsBridge(): DesktopAnalyticsBridge {
  const bitsentry = (window as { bitsentry?: unknown }).bitsentry
  const analytics = (bitsentry as DesktopAnalyticsBridge | undefined)?.analytics
  if (
    analytics === undefined ||
    typeof analytics.getContext !== 'function' ||
    typeof analytics.markFirstRunCaptured !== 'function'
  ) {
    throw new Error('Desktop analytics bridge is unavailable')
  }

  return { analytics }
}

export function configureDesktopPosthogRuntime({
  posthogClient,
  posthogKey,
  posthogHost,
  productName,
}: ConfigureDesktopPosthogRuntimeInput): DesktopPosthogApi {
  configuredPosthogClient = posthogClient
  POSTHOG_KEY = envString(posthogKey)
  POSTHOG_HOST = envString(posthogHost, 'https://us.i.posthog.com')
  PRODUCT_NAME = envString(productName, 'superterminal')

  return {
    initDesktopAnalytics,
    syncDesktopAnalyticsUser,
    captureDesktopAnalyticsEvent,
    captureDesktopAnalyticsException,
    captureDesktopPageview,
  }
}

function logPostHog(message: string, details?: Record<string, unknown>): void {
  if (details !== undefined) {
    console.info('[posthog]', message, JSON.stringify(details))
    return
  }

  console.info('[posthog]', message)
}

function warnPostHogFailure(action: string, error: unknown): void {
  console.warn(`[posthog] Failed to ${action}`, error)
}

function isConfigured(): boolean {
  return POSTHOG_KEY.length > 0
}

function withDefaultProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    product: PRODUCT_NAME,
    app_version: analyticsContext?.appVersion,
    release_channel: analyticsContext?.releaseChannel,
    platform: analyticsContext?.platform,
    ...properties,
  }
}

function daysBetween(start: Date, end: Date): number {
  const diffMs = end.getTime() - start.getTime()
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return 0
  }
  return Math.floor(diffMs / 86_400_000)
}

function readAppOpenReturnProperties(): Record<string, unknown> {
  if (typeof window === 'undefined') {
    return {}
  }

  const now = new Date()
  let daysSinceLastOpen: number | undefined

  try {
    const previous = window.localStorage.getItem(LAST_APP_OPENED_AT_KEY)
    if (previous !== null && previous.length > 0) {
      const previousDate = new Date(previous)
      if (!Number.isNaN(previousDate.getTime())) {
        daysSinceLastOpen = daysBetween(previousDate, now)
      }
    }
    window.localStorage.setItem(LAST_APP_OPENED_AT_KEY, now.toISOString())
  } catch {
    // Best-effort analytics only; localStorage issues should not affect startup.
  }

  const returnedAfterOneDay =
    typeof daysSinceLastOpen === 'number' && daysSinceLastOpen >= 1
  const returnedAfterSevenDays =
    typeof daysSinceLastOpen === 'number' && daysSinceLastOpen >= 7

  return {
    days_since_last_open: daysSinceLastOpen,
    returned_after_1_day: returnedAfterOneDay,
    returned_after_7_days: returnedAfterSevenDays,
  }
}

function envelopesForEventNames(
  eventNames: string[],
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  return eventNames.map((derivedEvent) => ({
    event: derivedEvent,
    properties,
  }))
}

function deriveDesktopAppOpenedEvents(
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  const events: AnalyticsEventEnvelope[] = [{ event: 'app_opened', properties }]
  if (properties?.returned_after_1_day === true) {
    events.push({ event: 'user_returned', properties })
  }

  return events
}

function deriveBetaAnalyticsEvents(
  event: string,
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  if (event === 'desktop_app_opened') {
    return deriveDesktopAppOpenedEvents(properties)
  }
  if (event === 'desktop_action_succeeded') {
    return deriveDesktopActionSuccessEvents(properties)
  }
  if (event === 'desktop_action_failed') {
    return deriveDesktopActionFailureEvents(properties)
  }

  const derivedEvent = SIMPLE_BETA_EVENTS.get(event)
  if (derivedEvent === undefined) {
    return []
  }

  return [{ event: derivedEvent, properties }]
}

function deriveDesktopActionSuccessEvents(
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  const action = properties?.action
  if (typeof action !== 'string') {
    return []
  }

  const eventNames = DESKTOP_ACTION_SUCCESS_EVENTS.get(action)
  if (eventNames === undefined) {
    return []
  }

  return envelopesForEventNames(eventNames, properties)
}

function deriveDesktopActionFailureEvents(
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  const action = properties?.action
  if (typeof action !== 'string') {
    return []
  }

  if (action === 'runbooks:execute') {
    return [{ event: 'runbook_run_failed', properties }]
  }

  if (action.startsWith('errorSources:')) {
    return [
      { event: 'connection_attempted', properties },
      { event: 'connection_failed', properties },
    ]
  }

  if (action === 'agent:start') {
    return [{ event: 'session_failed', properties }]
  }

  return []
}

function expandDesktopAnalyticsEvents(
  event: string,
  properties?: Record<string, unknown>,
): AnalyticsEventEnvelope[] {
  return [
    { event, properties },
    ...deriveBetaAnalyticsEvents(event, properties),
  ]
}

function flushPendingEvents(): void {
  if (analyticsContext === null) {
    return
  }

  const posthogClient = getPosthogClient()
  if (posthogClient === null) {
    return
  }

  const queuedCount = pendingEvents.length
  if (queuedCount > 0) {
    logPostHog('Flushing queued desktop analytics events', {
      count: queuedCount,
    })
  }

  while (pendingEvents.length > 0) {
    const nextEvent = pendingEvents.shift()
    if (nextEvent === undefined) {
      continue
    }

    try {
      posthogClient.capture(
        nextEvent.event,
        withDefaultProperties(nextEvent.properties),
      )
    } catch (error: unknown) {
      warnPostHogFailure(`capture ${nextEvent.event}`, error)
    }
  }
}

function flushPendingIdentifyUser(): void {
  if (pendingIdentifyUser === null) {
    return
  }

  const nextUser = pendingIdentifyUser
  pendingIdentifyUser = null
  syncDesktopAnalyticsUser(nextUser)
}

export async function initDesktopAnalytics(): Promise<void> {
  if (!isConfigured()) {
    logPostHog('Desktop analytics disabled because no PostHog key is configured')
    return
  }

  if (initialized) {
    return
  }

  initPromise ??= (async () => {
    const desktopAnalyticsBridge = getDesktopAnalyticsBridge()
    const context = await desktopAnalyticsBridge.analytics.getContext()
    analyticsContext = context
    telemetryEnabled = context.telemetryEnabled

    logPostHog('Loaded desktop analytics context', {
      telemetryEnabled,
      releaseChannel: context.releaseChannel,
      hasInstallationId: context.installationId !== null,
      shouldCaptureFirstRun: context.shouldCaptureFirstRun,
      appVersion: context.appVersion,
      platform: context.platform,
      host: POSTHOG_HOST,
    })

    if (!telemetryEnabled) {
      pendingEvents.length = 0
      pendingExceptions.length = 0
      logPostHog(
        'Desktop analytics initialization skipped because telemetry consent is disabled',
      )
      return
    }

    if (context.installationId === null) {
      pendingEvents.length = 0
      pendingExceptions.length = 0
      telemetryEnabled = false
      logPostHog(
        'Desktop analytics initialization aborted because installation id is missing',
      )
      warnPostHogFailure('initialize desktop analytics', new Error('Missing installation id'))
      return
    }

    const posthogClient = getPosthogClient()
    if (posthogClient === null) {
      pendingEvents.length = 0
      pendingExceptions.length = 0
      telemetryEnabled = false
      warnPostHogFailure(
        'initialize desktop analytics',
        new Error('Desktop PostHog client is unavailable'),
      )
      return
    }

    posthogClient.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      person_profiles: 'identified_only',
      bootstrap: {
        distinctID: context.installationId,
        isIdentifiedID: false,
      },
    })

    initialized = true
    logPostHog('Desktop analytics initialized', {
      distinctId: context.installationId,
      releaseChannel: context.releaseChannel,
      appVersion: context.appVersion,
      host: POSTHOG_HOST,
      personProfiles: 'identified_only',
    })
    captureDesktopAnalyticsEvent(
      'desktop_app_opened',
      readAppOpenReturnProperties(),
    )

    if (context.shouldCaptureFirstRun) {
      captureDesktopAnalyticsEvent('desktop_first_run')
      try {
        await desktopAnalyticsBridge.analytics.markFirstRunCaptured()
        logPostHog('Recorded first-run acknowledgement')
      } catch (error: unknown) {
        warnPostHogFailure('acknowledge first run capture', error)
      }
    }

    flushPendingIdentifyUser()
    flushPendingEvents()
    flushPendingExceptions()
  })().catch((error: unknown) => {
    initPromise = null
    initialized = false
    analyticsContext = null
    warnPostHogFailure('initialize desktop analytics', error)
  })

  return initPromise
}

function resetPendingIdentifyUser(): void {
  pendingIdentifyUser = null
  lastIdentifyFingerprint = null
}

function shouldQueueIdentifyUser(): boolean {
  return !initialized || analyticsContext === null
}

function desktopAnalyticsDistinctId(): string | null {
  if (analyticsContext === null) {
    return null
  }

  return analyticsContext.installationId
}

function buildIdentifyFingerprint(
  distinctId: string,
  user: DesktopAnalyticsUser,
): string {
  return JSON.stringify({
    distinctId,
    userId: String(user.id),
    email: user.email ?? null,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    totpEnabled: user.totpEnabled === true,
  })
}

function buildIdentifyProperties(
  user: DesktopAnalyticsUser,
): Record<string, unknown> {
  const context = analyticsContext
  if (context === null) {
    return {}
  }

  return {
    product: PRODUCT_NAME,
    person_scope: 'installation',
    local_user_id: String(user.id),
    email: user.email ?? undefined,
    first_name: user.firstName ?? undefined,
    last_name: user.lastName ?? undefined,
    totp_enabled: user.totpEnabled === true,
    release_channel: context.releaseChannel,
    app_version: context.appVersion,
    platform: context.platform,
  }
}

function logIdentifiedUser(
  distinctId: string,
  user: DesktopAnalyticsUser,
): void {
  const context = analyticsContext
  if (context === null) {
    return
  }

  logPostHog('Identified desktop analytics person', {
    distinctId,
    localUserId: String(user.id),
    hasEmail: user.email !== null && user.email !== undefined && user.email.length > 0,
    releaseChannel: context.releaseChannel,
  })
}

export function syncDesktopAnalyticsUser(user: DesktopAnalyticsUser | null): void {
  if (!isConfigured() || telemetryEnabled === false) {
    return
  }

  if (user === null) {
    resetPendingIdentifyUser()
    return
  }

  if (shouldQueueIdentifyUser()) {
    pendingIdentifyUser = user
    void initDesktopAnalytics()
    return
  }

  const distinctId = desktopAnalyticsDistinctId()
  if (distinctId === null) {
    return
  }

  const fingerprint = buildIdentifyFingerprint(distinctId, user)

  if (lastIdentifyFingerprint === fingerprint) {
    return
  }

  try {
    const posthogClient = getPosthogClient()
    if (posthogClient === null) {
      return
    }

    posthogClient.identify(distinctId, buildIdentifyProperties(user))
    lastIdentifyFingerprint = fingerprint
    logIdentifiedUser(distinctId, user)
  } catch (error: unknown) {
    warnPostHogFailure('identify desktop analytics user', error)
  }
}

export function captureDesktopAnalyticsEvent(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!isConfigured()) {
    return
  }

  if (telemetryEnabled === false) {
    logPostHog('Skipped desktop analytics event because telemetry consent is disabled', {
      event,
    })
    return
  }

  if (!initialized || analyticsContext === null) {
    pendingEvents.push(...expandDesktopAnalyticsEvents(event, properties))
    logPostHog('Queued desktop analytics event until initialization completes', {
      event,
      queueSize: pendingEvents.length,
    })
    void initDesktopAnalytics()
    return
  }

  try {
    const posthogClient = getPosthogClient()
    if (posthogClient === null) {
      return
    }

    for (const envelope of expandDesktopAnalyticsEvents(event, properties)) {
      posthogClient.capture(
        envelope.event,
        withDefaultProperties(envelope.properties),
      )
      logPostHog('Captured desktop analytics event', {
        event: envelope.event,
        properties: withDefaultProperties(envelope.properties),
      })
    }
  } catch (error: unknown) {
    warnPostHogFailure(`capture ${event}`, error)
  }
}

function flushPendingExceptions(): void {
  if (pendingExceptions.length === 0) {
    return
  }

  const posthogClient = getPosthogClient()
  if (posthogClient?.captureException === undefined) {
    warnPostHogFailure(
      'capture queued desktop exception',
      new Error('Desktop PostHog exception capture is unavailable'),
    )
    pendingExceptions.length = 0
    return
  }

  while (pendingExceptions.length > 0) {
    const error = pendingExceptions.shift()
    try {
      posthogClient.captureException(error)
      logPostHog('Captured queued desktop analytics exception')
    } catch (captureError: unknown) {
      warnPostHogFailure('capture queued desktop exception', captureError)
    }
  }
}

export function captureDesktopAnalyticsException(error: unknown): void {
  if (!isConfigured()) {
    return
  }

  if (telemetryEnabled === false) {
    logPostHog(
      'Skipped desktop analytics exception because telemetry consent is disabled',
    )
    return
  }

  if (!initialized || analyticsContext === null) {
    pendingExceptions.push(error)
    logPostHog('Queued desktop analytics exception until initialization completes', {
      queueSize: pendingExceptions.length,
    })
    void initDesktopAnalytics()
    return
  }

  const posthogClient = getPosthogClient()
  if (posthogClient?.captureException === undefined) {
    warnPostHogFailure(
      'capture desktop exception',
      new Error('Desktop PostHog exception capture is unavailable'),
    )
    return
  }

  try {
    posthogClient.captureException(error)
    logPostHog('Captured desktop analytics exception')
  } catch (captureError: unknown) {
    warnPostHogFailure('capture desktop exception', captureError)
  }
}

export function captureDesktopPageview(path: string): void {
  if (!isConfigured() || typeof window === 'undefined') {
    return
  }

  const pathWithoutQuery = path.split('?')[0] ?? ''
  const pathWithoutHash = pathWithoutQuery.split('#')[0] ?? ''
  let safePath = '/'
  if (pathWithoutHash.length > 0) {
    safePath = pathWithoutHash
  }
  captureDesktopAnalyticsEvent('$pageview', {
    $current_url: `${window.location.origin}${safePath}`,
    path: safePath,
  })
  captureDesktopAnalyticsEvent('desktop_page_viewed', {
    path: safePath,
  })
}
