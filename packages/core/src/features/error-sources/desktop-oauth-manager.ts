import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import type { ErrorSourceType } from "./error-sources.schemas";
import { getProviderForSource } from "./desktop-posthog-provider-binding";
import { assertAllowedPostHogBaseUrl } from "./posthog-base-url";
import {
  isOAuthPluginErrorSourceType,
  type OAuthPluginErrorSourceType,
} from "./plugin-backed-error-sources";

export interface DesktopOAuthSettingsDatabase {
  setting: {
    delete(args: { where: { key: string } }): Promise<unknown>;
    findMany(args: {
      where: {
        key: { startsWith: string };
      };
    }): Promise<Array<Record<string, unknown>>>;
    findUnique(args: {
      where: { key: string };
    }): Promise<Record<string, unknown> | null>;
    upsert(args: {
      where: { key: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

export interface DesktopOAuthAuthorizeInput {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}

export interface DesktopOAuthTokenExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  signal?: AbortSignal;
}

export interface DesktopOAuthTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}

export interface DesktopOAuthProvider {
  buildAuthorizeUrl(input: DesktopOAuthAuthorizeInput): string;
  exchangeCodeForToken(
    input: DesktopOAuthTokenExchangeInput,
  ): Promise<DesktopOAuthTokenResponse>;
}

export interface InitiateOAuthInput {
  pluginId?: string;
  clientId?: string;
  redirectUri?: string;
  baseUrl?: string;
  posthogBaseUrl?: string;
}

export interface CompleteOAuthInput {
  code: string;
  state: string;
  pluginId?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
  posthogBaseUrl?: string;
}

export interface OAuthProviderConfig {
  envClientIdName: string;
  envClientSecretName: string;
  envRedirectUriName: string;
  defaultRedirectUri: string;
  scopes: string[];
  publicClient: boolean;
}

type PendingOauthState = {
  sourceType: ErrorSourceType;
  pluginId?: string;
  codeVerifier: string;
  createdAt: string;
  providerBaseUrl?: string;
};

export type OAuthSourceType = OAuthPluginErrorSourceType;

export function createDesktopOAuthProviderConfigs(
  defaultRedirectUri: string,
): Record<OAuthSourceType, OAuthProviderConfig> {
  return {
    sentry: {
      envClientIdName: "SENTRY_OAUTH_CLIENT_ID",
      envClientSecretName: "SENTRY_OAUTH_CLIENT_SECRET",
      envRedirectUriName: "SENTRY_OAUTH_REDIRECT_URI",
      defaultRedirectUri,
      scopes: ["org:read", "project:read", "event:read"],
      publicClient: false,
    },
    posthog: {
      envClientIdName: "POSTHOG_OAUTH_CLIENT_ID",
      envClientSecretName: "POSTHOG_OAUTH_CLIENT_SECRET",
      envRedirectUriName: "POSTHOG_OAUTH_REDIRECT_URI",
      defaultRedirectUri,
      scopes: [
        "organization:read",
        "project:read",
        "error_tracking:read",
        "query:read",
        "event:read",
      ],
      publicClient: true,
    },
  };
}

const OAUTH_STATE_PREFIX = "errorSources.oauth.";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function getRequiredEnv(name: string, sourceType: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (value.length === 0) {
    throw new Error(`${name} is required for ${sourceType} OAuth`);
  }
  return value;
}

function isExpired(createdAt: string): boolean {
  const createdAtMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) return true;
  return Date.now() - createdAtMs > OAUTH_STATE_TTL_MS;
}

function parsePostHogExtraAllowedHosts(): string[] {
  const raw = process.env.POSTHOG_ALLOWED_BASE_URLS;
  if (raw === undefined || raw.length === 0) return [];
  const out: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(new URL(trimmed).host.toLowerCase());
    } catch {
      out.push(trimmed.toLowerCase());
    }
  }
  return out;
}

function readPostHogBaseUrl(input: {
  baseUrl?: string;
  posthogBaseUrl?: string;
}): string | undefined {
  const raw = input.baseUrl?.trim() ?? input.posthogBaseUrl?.trim() ?? "";
  if (raw.length === 0) {
    return undefined;
  }
  return raw;
}

function validatePostHogOAuthBaseUrl(value: string | undefined): string {
  return assertAllowedPostHogBaseUrl(value, {
    extraAllowedHosts: parsePostHogExtraAllowedHosts(),
  });
}

type ElectronShellLike = {
  openExternal(url: string): Promise<void> | void;
};

function tryGetElectronShell(): ElectronShellLike | null {
  try {
    const electron = require("electron") as unknown;
    if (
      electron === null ||
      electron === undefined ||
      typeof electron !== "object" ||
      Array.isArray(electron)
    ) {
      return null;
    }

    const shell = (electron as { shell?: unknown }).shell;
    if (
      shell !== null &&
      shell !== undefined &&
      typeof shell === "object" &&
      typeof (shell as ElectronShellLike).openExternal === "function"
    ) {
      return shell as ElectronShellLike;
    }
  } catch {
    return null;
  }

  return null;
}

async function openExternalUrl(url: string): Promise<void> {
  const electronShell = tryGetElectronShell();
  if (electronShell !== null) {
    await electronShell.openExternal(url);
    return;
  }

  let invocation = { command: "xdg-open", args: [url] };
  if (process.platform === "darwin") {
    invocation = { command: "open", args: [url] };
  } else if (process.platform === "win32") {
    invocation = { command: "cmd", args: ["/d", "/s", "/c", "start", "", url] };
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export interface DesktopOauthManagerOptions {
  providerConfigs: Record<OAuthSourceType, OAuthProviderConfig>;
  resolveProvider(input: {
    sourceType: ErrorSourceType;
    pluginId?: string;
    providerBaseUrl?: string;
  }): DesktopOAuthProvider;
  resolvePluginManifest?: (
    pluginId: string,
  ) => {
    metadata?: {
      errorSource?: {
        sourceType?: ErrorSourceType;
        oauth?: Partial<OAuthProviderConfig>;
      };
    };
  } | null;
}

export interface DesktopOauthManagerProviderFactory {
  getProvider(sourceType: ErrorSourceType): DesktopOAuthProvider;
  getProviderForSource?: (source: {
    sourceType: ErrorSourceType;
    additionalMetadata?: unknown;
    configuration?: {
      posthogBaseUrl?: unknown;
    };
  }) => DesktopOAuthProvider;
  getPlugin?: (
    pluginId: string,
  ) => {
    metadata?: {
      errorSource?: {
        sourceType?: ErrorSourceType;
        oauth?: Partial<OAuthProviderConfig>;
      };
    };
  } | null;
}

export interface DesktopOauthManagerBindings {
  providerConfigs: Record<OAuthSourceType, OAuthProviderConfig>;
  OauthManagerService: new (
    db: DesktopOAuthSettingsDatabase,
    providerFactory: DesktopOauthManagerProviderFactory,
  ) => DesktopOauthManagerService;
}

export function createDesktopOauthManagerBindings(
  defaultRedirectUri: string,
): DesktopOauthManagerBindings {
  const providerConfigs = createDesktopOAuthProviderConfigs(defaultRedirectUri);

  return {
    providerConfigs,
    OauthManagerService: class OauthManagerService extends DesktopOauthManagerService {
      constructor(
        db: DesktopOAuthSettingsDatabase,
        providerFactory: DesktopOauthManagerProviderFactory,
      ) {
        super(db, {
          providerConfigs,
          resolveProvider: ({ sourceType, pluginId, providerBaseUrl }) =>
            getProviderForSource(providerFactory, {
              sourceType,
              additionalMetadata:
                pluginId === undefined ? undefined : { pluginId },
              configuration: {
                posthogBaseUrl: providerBaseUrl,
              },
            }),
          resolvePluginManifest: (pluginId) =>
            providerFactory.getPlugin?.(pluginId) ?? null,
        });
      }
    },
  };
}

export class DesktopOauthManagerService {
  constructor(
    private readonly db: DesktopOAuthSettingsDatabase,
    private readonly options: DesktopOauthManagerOptions,
  ) {}

  private getPluginProviderConfig(
    sourceType: ErrorSourceType,
    pluginId?: string,
  ): Partial<OAuthProviderConfig> | undefined {
    const normalizedPluginId = pluginId?.trim();
    if (
      normalizedPluginId === undefined ||
      normalizedPluginId.length === 0 ||
      this.options.resolvePluginManifest === undefined
    ) {
      return undefined;
    }

    const plugin = this.options.resolvePluginManifest(normalizedPluginId);
    if (plugin?.metadata?.errorSource?.sourceType !== sourceType) {
      return undefined;
    }

    return plugin.metadata.errorSource.oauth;
  }

  private getProviderConfig(
    sourceType: ErrorSourceType,
    pluginId?: string,
  ): OAuthProviderConfig {
    if (!isOAuthPluginErrorSourceType(sourceType)) {
      throw new Error(`OAuth is not configured for source type: ${sourceType}`);
    }

    const baseConfig = this.options.providerConfigs[sourceType];
    const pluginOverrides = this.getPluginProviderConfig(sourceType, pluginId);
    if (pluginOverrides === undefined) {
      return baseConfig;
    }

    return {
      envClientIdName:
        pluginOverrides.envClientIdName ?? baseConfig.envClientIdName,
      envClientSecretName:
        pluginOverrides.envClientSecretName ?? baseConfig.envClientSecretName,
      envRedirectUriName:
        pluginOverrides.envRedirectUriName ?? baseConfig.envRedirectUriName,
      defaultRedirectUri:
        pluginOverrides.defaultRedirectUri ?? baseConfig.defaultRedirectUri,
      scopes: pluginOverrides.scopes ?? baseConfig.scopes,
      publicClient: pluginOverrides.publicClient ?? baseConfig.publicClient,
    };
  }

  private getProviderForOAuth(
    sourceType: ErrorSourceType,
    pluginId?: string,
    providerBaseUrl?: string,
  ): DesktopOAuthProvider {
    return this.options.resolveProvider({
      sourceType,
      pluginId,
      providerBaseUrl,
    });
  }

  async initiateOAuth(
    sourceType: ErrorSourceType,
    input?: InitiateOAuthInput,
  ): Promise<{ state: string; authUrl: string; redirectUri: string }> {
    await this.pruneExpiredPendingStates();

    const pluginId = input?.pluginId?.trim() || undefined;
    const config = this.getProviderConfig(sourceType, pluginId);
    let clientId = input?.clientId?.trim() ?? "";
    if (clientId.length === 0) {
      clientId = getRequiredEnv(config.envClientIdName, sourceType);
    }
    let redirectUri = input?.redirectUri?.trim() ?? "";
    if (redirectUri.length === 0) {
      redirectUri = process.env[config.envRedirectUriName]?.trim() ?? "";
    }
    if (redirectUri.length === 0) {
      redirectUri = config.defaultRedirectUri;
    }

    const state = toBase64Url(randomBytes(24));
    const codeVerifier = toBase64Url(randomBytes(64));
    const codeChallenge = toBase64Url(
      createHash("sha256").update(codeVerifier).digest(),
    );

    let providerBaseUrl: string | undefined;
    if (sourceType === "posthog") {
      providerBaseUrl = validatePostHogOAuthBaseUrl(
        readPostHogBaseUrl(input ?? {}),
      );
    }
    const provider = this.getProviderForOAuth(
      sourceType,
      pluginId,
      providerBaseUrl,
    );
    const authUrl = provider.buildAuthorizeUrl({
      clientId,
      redirectUri,
      scopes: config.scopes,
      state,
      codeChallenge,
    });

    const record: PendingOauthState = {
      sourceType,
      pluginId,
      codeVerifier,
      createdAt: nowIso(),
    };
    if (providerBaseUrl !== undefined) {
      record.providerBaseUrl = providerBaseUrl;
    }

    await this.db.setting.upsert({
      where: { key: `${OAUTH_STATE_PREFIX}${state}` },
      create: {
        key: `${OAUTH_STATE_PREFIX}${state}`,
        value: JSON.stringify(record),
        type: "json",
      },
      update: {
        value: JSON.stringify(record),
      },
    });

    await openExternalUrl(authUrl);
    return { state, authUrl, redirectUri };
  }

  async completeOAuth(
    sourceType: ErrorSourceType,
    input: CompleteOAuthInput,
  ): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: string | null;
    scopes: string[];
  }> {
    const key = `${OAUTH_STATE_PREFIX}${input.state}`;
    const row = await this.db.setting.findUnique({ where: { key } });
    if (row === null) {
      throw new Error("Invalid or expired OAuth state");
    }

    try {
      let pending: PendingOauthState;
      try {
        pending = JSON.parse(String(row.value)) as PendingOauthState;
      } catch {
        throw new Error("Corrupted OAuth state payload");
      }
      const requestedPluginId = input.pluginId?.trim() || undefined;

      if (
        pending.sourceType !== sourceType ||
        (pending.pluginId !== undefined && pending.pluginId !== requestedPluginId) ||
        pending.codeVerifier.length === 0
      ) {
        throw new Error("Invalid OAuth state payload");
      }

      if (isExpired(pending.createdAt)) {
        throw new Error("OAuth state expired. Please try again.");
      }

      const effectivePluginId = pending.pluginId ?? requestedPluginId;
      const config = this.getProviderConfig(sourceType, effectivePluginId);
      let pendingBaseUrl: string | undefined;
      if (
        pending.sourceType === "posthog" &&
        pending.providerBaseUrl !== undefined
      ) {
        pendingBaseUrl = validatePostHogOAuthBaseUrl(pending.providerBaseUrl);
      }
      let requestedBaseUrl: string | undefined;
      if (sourceType === "posthog") {
        requestedBaseUrl = readPostHogBaseUrl({
          baseUrl: input.baseUrl,
          posthogBaseUrl: input.posthogBaseUrl,
        });
      }
      let validatedRequestedBaseUrl: string | undefined;
      if (sourceType === "posthog" && requestedBaseUrl !== undefined) {
        validatedRequestedBaseUrl =
          validatePostHogOAuthBaseUrl(requestedBaseUrl);
      }
      if (
        pendingBaseUrl !== undefined &&
        validatedRequestedBaseUrl !== undefined &&
        pendingBaseUrl !== validatedRequestedBaseUrl
      ) {
        throw new Error(
          "PostHog OAuth base URL changed between authorization and token exchange",
        );
      }
      const providerBaseUrl = pendingBaseUrl ?? validatedRequestedBaseUrl;
      const provider = this.getProviderForOAuth(
        sourceType,
        effectivePluginId,
        providerBaseUrl,
      );
      let clientId = input.clientId?.trim() ?? "";
      if (clientId.length === 0) {
        clientId = getRequiredEnv(config.envClientIdName, sourceType);
      }
      let clientSecret = input.clientSecret?.trim() ?? "";
      if (clientSecret.length === 0 && config.publicClient) {
        clientSecret =
          process.env[config.envClientSecretName]?.trim() ?? "";
      }
      if (clientSecret.length === 0 && !config.publicClient) {
        clientSecret = getRequiredEnv(config.envClientSecretName, sourceType);
      }
      let redirectUri = input.redirectUri?.trim() ?? "";
      if (redirectUri.length === 0) {
        redirectUri = process.env[config.envRedirectUriName]?.trim() ?? "";
      }
      if (redirectUri.length === 0) {
        redirectUri = config.defaultRedirectUri;
      }

      const tokens = await provider.exchangeCodeForToken({
        clientId,
        clientSecret,
        code: input.code,
        redirectUri,
        codeVerifier: pending.codeVerifier,
      });

      if (tokens.accessToken.length === 0) {
        throw new Error(
          `${sourceType} token exchange succeeded but returned empty access token`,
        );
      }

      let expiresAt: string | null = null;
      if (tokens.expiresIn !== undefined && Number.isFinite(tokens.expiresIn)) {
        expiresAt = new Date(
          Date.now() + tokens.expiresIn * 1000,
        ).toISOString();
      }

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresAt,
        scopes: (tokens.scope ?? "")
          .split(/\s+/)
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0),
      };
    } finally {
      await this.deletePendingState(key);
    }
  }

  initiateSentryOAuth(input?: InitiateOAuthInput) {
    return this.initiateOAuth("sentry", input);
  }

  completeSentryOAuth(input: CompleteOAuthInput) {
    return this.completeOAuth("sentry", input);
  }

  initiatePostHogOAuth(input?: InitiateOAuthInput) {
    return this.initiateOAuth("posthog", input);
  }

  completePostHogOAuth(input: CompleteOAuthInput) {
    return this.completeOAuth("posthog", input);
  }

  private async pruneExpiredPendingStates(): Promise<void> {
    const states = await this.db.setting.findMany({
      where: {
        key: { startsWith: OAUTH_STATE_PREFIX },
      },
    });

    for (const state of states) {
      if (typeof state.key !== "string" || typeof state.value !== "string") {
        continue;
      }
      const key = state.key;
      if (!key.startsWith(OAUTH_STATE_PREFIX)) continue;
      const value = state.value;

      let shouldDelete = true;
      try {
        const parsed = JSON.parse(value) as PendingOauthState;
        if (typeof parsed.createdAt === "string") {
          shouldDelete = isExpired(parsed.createdAt);
        }
      } catch {
        shouldDelete = true;
      }

      if (shouldDelete) {
        await this.deletePendingState(key);
      }
    }
  }

  private async deletePendingState(key: string): Promise<void> {
    try {
      await this.db.setting.delete({ where: { key } });
    } catch {
      // best-effort cleanup for already-removed state
    }
  }
}
