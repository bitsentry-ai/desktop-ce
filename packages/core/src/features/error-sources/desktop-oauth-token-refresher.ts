import type {
  ErrorSourceConfiguration,
  ErrorSourceType,
} from "./desktop-error-sources.types";
import type {
  DesktopOAuthTokenResponse,
  OAuthProviderConfig,
} from "./desktop-oauth-manager";
import { getProviderForSource } from "./desktop-posthog-provider-binding";
import {
  isOAuthPluginErrorSourceType,
  type OAuthPluginErrorSourceType,
} from "./plugin-backed-error-sources";

type DesktopOAuthProviderConfigMap = Record<
  OAuthPluginErrorSourceType,
  Pick<
    OAuthProviderConfig,
    "envClientIdName" | "envClientSecretName" | "publicClient"
  >
>;

const DESKTOP_OAUTH_PROVIDER_CONFIGS: DesktopOAuthProviderConfigMap = {
  sentry: {
    envClientIdName: "SENTRY_OAUTH_CLIENT_ID",
    envClientSecretName: "SENTRY_OAUTH_CLIENT_SECRET",
    publicClient: false,
  },
  posthog: {
    envClientIdName: "POSTHOG_OAUTH_CLIENT_ID",
    envClientSecretName: "POSTHOG_OAUTH_CLIENT_SECRET",
    publicClient: true,
  },
};

type PluginOAuthProviderConfigOverride = Partial<
  Pick<
    OAuthProviderConfig,
    "envClientIdName" | "envClientSecretName" | "publicClient"
  >
>;

type DesktopPluginMetadataLike = {
  metadata?: {
    errorSource?: {
      sourceType?: ErrorSourceType;
      oauth?: PluginOAuthProviderConfigOverride;
    };
  };
};

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (normalized.length === 0) return null;

  return normalized;
}

function getRequiredEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getProviderConfig(
  sourceType: ErrorSourceType,
):
  | DesktopOAuthProviderConfigMap[OAuthPluginErrorSourceType]
  | undefined {
  if (isOAuthPluginErrorSourceType(sourceType)) {
    return DESKTOP_OAUTH_PROVIDER_CONFIGS[sourceType];
  }

  return undefined;
}

function readSourcePluginId(source: Pick<DesktopOAuthSource, "sourceType" | "additionalMetadata">): string {
  const additionalMetadata = source.additionalMetadata;
  if (
    additionalMetadata === null ||
    additionalMetadata === undefined ||
    typeof additionalMetadata !== "object" ||
    Array.isArray(additionalMetadata)
  ) {
    return source.sourceType;
  }

  const pluginId = (additionalMetadata as { pluginId?: unknown }).pluginId;
  const normalizedPluginId = readOptionalString(pluginId);
  if (normalizedPluginId !== null) {
    return normalizedPluginId;
  }

  return source.sourceType;
}

function getPluginProviderConfigOverride(
  source: Pick<DesktopOAuthSource, "sourceType" | "additionalMetadata">,
  providerFactory: {
    getPlugin?: (pluginId: string) => DesktopPluginMetadataLike | null;
  },
): PluginOAuthProviderConfigOverride | undefined {
  const pluginId = readSourcePluginId(source);
  const plugin = providerFactory.getPlugin?.(pluginId);
  if (plugin?.metadata?.errorSource?.sourceType !== source.sourceType) {
    return undefined;
  }

  return plugin.metadata.errorSource.oauth;
}

function getExpiresAtMs(expiresAt: string | null): number {
  if (expiresAt === null || expiresAt.length === 0) {
    return Number.NaN;
  }

  return new Date(expiresAt).getTime();
}

function getNextAccessToken(refreshedAccessToken: unknown): string {
  const accessToken = readOptionalString(refreshedAccessToken);
  if (accessToken === null) {
    throw new Error("Token refresh succeeded but no access token was returned");
  }

  return accessToken;
}

function getNextRefreshToken(
  currentRefreshToken: string | null,
  refreshedToken: unknown,
): string | null {
  const nextRefreshToken = readOptionalString(refreshedToken);
  if (nextRefreshToken !== null) {
    return nextRefreshToken;
  }

  return currentRefreshToken;
}

function getNextExpiresAt(
  currentExpiresAt: string | null,
  expiresIn: unknown,
): string | null {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
    return new Date(Date.now() + expiresIn * 1000).toISOString();
  }

  return currentExpiresAt;
}

function getNextGrantedScopes(
  currentScopes: string[],
  scope: unknown,
): string[] {
  const refreshedScope = readOptionalString(scope);
  if (refreshedScope === null) {
    return currentScopes;
  }

  return refreshedScope
    .split(/\s+/)
    .map((scopeValue) => scopeValue.trim())
    .filter((scopeValue) => scopeValue.length > 0);
}

function getClientSecret(
  config: DesktopOAuthProviderConfigMap[OAuthPluginErrorSourceType],
  sourceConfigSecret: unknown,
): string {
  const configuredSecret = readOptionalString(sourceConfigSecret);
  if (configuredSecret !== null) {
    return configuredSecret;
  }

  if (config.publicClient) {
    return readOptionalString(process.env[config.envClientSecretName]) ?? "";
  }

  return getRequiredEnv(config.envClientSecretName);
}

export interface DesktopOAuthSource {
  id: string;
  name: string;
  sourceType: ErrorSourceType;
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  expiresAt: string | null;
  grantedScopes: string[];
  configuration?: ErrorSourceConfiguration;
  logLevelThreshold?: unknown;
  additionalMetadata?: unknown;
  syncEnabled?: unknown;
  autoDiagnosisEnabled?: unknown;
  lastSyncAt?: unknown;
  lastSyncStatus?: unknown;
  lastSyncError?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface DesktopOAuthSourcesRepository {
  update(args: {
    id: string;
    accessTokenRef: string;
    refreshTokenRef: string | null;
    expiresAt: string | null;
    grantedScopes: string[];
  }): Promise<unknown>;
}

export interface DesktopOAuthRefreshProvider {
  refreshToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    signal?: AbortSignal;
  }): Promise<DesktopOAuthTokenResponse>;
}

export interface RefreshAccessTokenInput<
  TSource extends DesktopOAuthSource = DesktopOAuthSource,
  TProvider extends DesktopOAuthRefreshProvider = DesktopOAuthRefreshProvider,
> {
  source: TSource;
  sourcesRepository: DesktopOAuthSourcesRepository;
  providerFactory: {
    getProvider(sourceType: TSource["sourceType"]): TProvider;
    getProviderForSource?: (source: {
      sourceType: TSource["sourceType"];
      additionalMetadata?: unknown;
      configuration?: {
        posthogBaseUrl?: unknown;
      };
    }) => TProvider;
    getPlugin?: (pluginId: string) => DesktopPluginMetadataLike | null;
  };
  signal?: AbortSignal;
}

/**
 * Module-level lock map keyed by `source.id`. A single error-source row can be
 * touched concurrently by the scheduled sync, an external-source runbook
 * query, and any future caller — and OAuth refresh tokens rotate one-time on
 * use. Without a shared lock, two callers that each see the same expiring
 * access token would each fire a refresh and only one of the new refresh
 * tokens would survive in storage, breaking the other path permanently.
 *
 * The lock lives at module scope (rather than on an instance) so all
 * services share the same in-flight refresh promise per source — the lock
 * spans `ErrorSourceSyncService` AND
 * `ExternalSourceRunbookQueryService`.
 */
const inflightRefreshes = new Map<string, Promise<string>>();

function resolveWithoutRefreshToken(
  source: DesktopOAuthSource,
  accessToken: string,
  isExpired: boolean,
): string {
  if (accessToken.length === 0) {
    throw new Error(
      `Source "${source.name}" is missing both access and refresh tokens`,
    );
  }
  if (isExpired) {
    // Returning a stale access token here would loop the caller into
    // permanent opaque 401s with no signal that re-authentication is
    // required. Surface the condition explicitly so the UI can prompt
    // the user to reconnect the source.
    throw new Error(
      `Source "${source.name}" has an expired access token and no refresh token; reconnect the source`,
    );
  }

  return accessToken;
}

/**
 * Resolve a usable access token for a source, refreshing via OAuth when the
 * stored token is expired or missing. Concurrent calls for the same
 * `source.id` collapse onto one in-flight refresh.
 */
export async function refreshSourceAccessToken<
  TSource extends DesktopOAuthSource,
  TProvider extends DesktopOAuthRefreshProvider,
>(input: RefreshAccessTokenInput<TSource, TProvider>): Promise<string> {
  const { source } = input;
  const accessToken = readOptionalString(source.accessTokenRef) ?? "";

  const expiresAtMs = getExpiresAtMs(source.expiresAt);
  const isExpired =
    Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() <= 60_000;

  if (accessToken.length > 0 && !isExpired) {
    return accessToken;
  }

  const refreshToken = readOptionalString(source.refreshTokenRef) ?? "";
  if (refreshToken.length === 0) {
    return resolveWithoutRefreshToken(source, accessToken, isExpired);
  }

  const inflight = inflightRefreshes.get(source.id);
  if (inflight !== undefined) {
    return inflight;
  }
  const promise = performTokenRefresh(input, refreshToken).finally(() => {
    inflightRefreshes.delete(source.id);
  });
  inflightRefreshes.set(source.id, promise);
  return promise;
}

async function performTokenRefresh<
  TSource extends DesktopOAuthSource,
  TProvider extends DesktopOAuthRefreshProvider,
>(
  input: RefreshAccessTokenInput<TSource, TProvider>,
  refreshToken: string,
): Promise<string> {
  const { source, sourcesRepository, providerFactory, signal } = input;
  const provider = getProviderForSource(providerFactory, {
    sourceType: source.sourceType,
    additionalMetadata: source.additionalMetadata,
    configuration: source.configuration,
  });
  const config = source.configuration ?? {};
  const providerConfig = getProviderConfig(source.sourceType);
  if (providerConfig === undefined) {
    throw new Error(
      `OAuth refresh is not configured for source type: ${source.sourceType}`,
    );
  }
  const pluginConfigOverride = getPluginProviderConfigOverride(
    source,
    providerFactory,
  );
  const effectiveProviderConfig = {
    envClientIdName:
      pluginConfigOverride?.envClientIdName ?? providerConfig.envClientIdName,
    envClientSecretName:
      pluginConfigOverride?.envClientSecretName ??
      providerConfig.envClientSecretName,
    publicClient:
      pluginConfigOverride?.publicClient ?? providerConfig.publicClient,
  };
  const oauthClientId =
    readOptionalString(config.oauthClientId) ??
    getRequiredEnv(effectiveProviderConfig.envClientIdName);
  const oauthClientSecret = getClientSecret(
    effectiveProviderConfig,
    config.oauthClientSecret,
  );

  const refreshed = await provider.refreshToken({
    clientId: oauthClientId,
    clientSecret: oauthClientSecret,
    refreshToken,
    signal,
  });
  const nextAccessToken = getNextAccessToken(refreshed.accessToken);
  const updated = await sourcesRepository.update({
    id: source.id,
    accessTokenRef: nextAccessToken,
    refreshTokenRef: getNextRefreshToken(
      source.refreshTokenRef,
      refreshed.refreshToken,
    ),
    expiresAt: getNextExpiresAt(source.expiresAt, refreshed.expiresIn),
    grantedScopes: getNextGrantedScopes(source.grantedScopes, refreshed.scope),
  });

  if (updated === null) {
    throw new Error(
      `Failed to persist refreshed tokens for source ${source.id}`,
    );
  }

  return nextAccessToken;
}
