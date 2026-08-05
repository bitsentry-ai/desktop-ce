const DOWNLOADS_HOST = 'downloads.bitsentry.ai'
const PRODUCT_UPDATE_PATH = {
  ce: 'desktop-ce',
  pro: 'desktop',
} as const
const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const STABLE_FEED_PATHS: Partial<Record<NodeJS.Platform, Partial<Record<string, string>>>> = {
  darwin: {
    arm64: 'macos/arm64',
    x64: 'macos/x64',
  },
  win32: {
    x64: 'windows/x64',
  },
  linux: {
    arm64: 'linux/arm64',
    x64: 'linux/x64',
  },
}

export type UpdateDownloadPolicy = 'auto' | 'manual'
export type DesktopReleaseChannel = 'stable' | 'beta' | 'preview'
export type DesktopProduct = keyof typeof PRODUCT_UPDATE_PATH
export type AutoUpdaterDisabledReasonCode =
  | 'not-packaged'
  | 'smoke-test'
  | 'unsupported-feed'

export interface AutoUpdaterEnablement {
  enabled: boolean
  disabledReasonCode: AutoUpdaterDisabledReasonCode | null
  feedUrl: string | null
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string | null
}

function parseVersion(input: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(input.trim())
  if (match === null) return null
  let prerelease: string | null = null
  const prereleaseMatch = match[4]
  if (prereleaseMatch !== undefined) {
    prerelease = prereleaseMatch
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function extractConfiguredFeedUrl(appUpdateConfigContents?: string | null): string | null {
  if (appUpdateConfigContents === undefined || appUpdateConfigContents === null) return null
  if (appUpdateConfigContents.length === 0) return null

  for (const rawLine of appUpdateConfigContents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('url:')) continue

    const value = line.slice(4).trim()
    if (value.length === 0) return null

    return value.replace(/^['"]|['"]$/g, '')
  }

  return null
}

function getCanonicalStableFeedPath(platform: NodeJS.Platform, arch: string): string | null {
  const platformPaths = STABLE_FEED_PATHS[platform]
  if (platformPaths === undefined) {
    return null
  }

  return platformPaths[arch] ?? null
}

function normalizeConfiguredFeedUrl(input: string, product: DesktopProduct): string | null {
  try {
    const url = new URL(input)
    const productUpdatePath = PRODUCT_UPDATE_PATH[product]

    if (url.pathname.includes('/local-build-placeholder')) {
      return null
    }

    if (
      url.hostname === DOWNLOADS_HOST &&
      !url.pathname.startsWith(`/${productUpdatePath}/`)
    ) {
      return null
    }

    const stableReleaseMatch =
      new RegExp(
        `^\\/${productUpdatePath}\\/releases\\/(macos\\/(?:arm64|x64)|windows\\/x64|linux\\/(?:arm64|x64))\\/(?:desktop|desktop-ce)-v[^/]+\\/?$`,
      ).exec(url.pathname)

    if (stableReleaseMatch !== null) {
      url.pathname = `/${productUpdatePath}/releases/${stableReleaseMatch[1]}`
    }

    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function resolveFallbackFeedUrl(options: {
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  releaseChannel: DesktopReleaseChannel
  product: DesktopProduct
}): string | null {
  if (options.releaseChannel !== 'stable') return null

  const current = parseVersion(options.currentVersion)
  if (current === null) return null
  if (current.prerelease !== null) return null

  const stableFeedPath = getCanonicalStableFeedPath(options.platform, options.arch)
  if (stableFeedPath === null) return null

  return `https://downloads.bitsentry.ai/${PRODUCT_UPDATE_PATH[options.product]}/releases/${stableFeedPath}`
}

export function getAutoUpdaterEnablement(options: {
  isPackaged: boolean
  isSmokeTest: boolean
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  releaseChannel: DesktopReleaseChannel
  appUpdateConfigContents?: string | null
  product?: DesktopProduct
}): AutoUpdaterEnablement {
  if (!options.isPackaged) {
    return {
      enabled: false,
      disabledReasonCode: 'not-packaged',
      feedUrl: null,
    }
  }

  if (options.isSmokeTest) {
    return {
      enabled: false,
      disabledReasonCode: 'smoke-test',
      feedUrl: null,
    }
  }

  const product = options.product ?? 'pro'
  const configuredFeedUrl = extractConfiguredFeedUrl(options.appUpdateConfigContents)
  let feedUrl: string | null = null
  if (configuredFeedUrl !== null) {
    feedUrl = normalizeConfiguredFeedUrl(configuredFeedUrl, product)
  }
  if (feedUrl === null) {
    feedUrl = resolveFallbackFeedUrl({
      currentVersion: options.currentVersion,
      platform: options.platform,
      arch: options.arch,
      releaseChannel: options.releaseChannel,
      product,
    })
  }

  if (feedUrl === null) {
    return {
      enabled: false,
      disabledReasonCode: 'unsupported-feed',
      feedUrl: null,
    }
  }

  return { enabled: true, disabledReasonCode: null, feedUrl }
}

export function getUpdateDownloadPolicy(options: {
  currentVersion: string
  availableVersion: string
}): UpdateDownloadPolicy {
  const current = parseVersion(options.currentVersion)
  const available = parseVersion(options.availableVersion)

  if (current === null) return 'manual'
  if (available === null) return 'manual'
  if (current.prerelease !== null || available.prerelease !== null) return 'manual'
  if (available.major !== current.major) return 'manual'

  if (available.minor > current.minor) return 'auto'
  if (available.minor === current.minor && available.patch > current.patch) return 'auto'

  return 'manual'
}
