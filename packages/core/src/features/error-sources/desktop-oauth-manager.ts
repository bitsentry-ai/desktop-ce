import { spawn } from "child_process";
import { createHash, randomBytes } from "crypto";
import type { ErrorSourceType } from "./error-sources.schemas";
import type { DesktopPluginRuntimeService } from "../plugins";
import { createDesktopNodePluginRuntimeService } from "../plugins/node";
import {
  buildPluginAuthorizeUrl,
  exchangePluginCodeForToken,
  resolvePluginOAuthConfig,
} from "./desktop-plugin-oauth-actions";

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

export interface InitiateOAuthInput {
  pluginId?: string;
  clientId?: string;
  redirectUri?: string;
  baseUrl?: string;
}

export interface CompleteOAuthInput {
  code: string;
  state: string;
  pluginId?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
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

function readMissingOAuthProviderConfigKeys(
  config: Partial<OAuthProviderConfig>,
): string[] {
  const missing: string[] = [];

  if (typeof config.envClientIdName !== "string" || config.envClientIdName.trim().length === 0) {
    missing.push("envClientIdName");
  }
  if (typeof config.envClientSecretName !== "string" || config.envClientSecretName.trim().length === 0) {
    missing.push("envClientSecretName");
  }
  if (typeof config.envRedirectUriName !== "string" || config.envRedirectUriName.trim().length === 0) {
    missing.push("envRedirectUriName");
  }
  if (typeof config.defaultRedirectUri !== "string" || config.defaultRedirectUri.trim().length === 0) {
    missing.push("defaultRedirectUri");
  }
  if (!Array.isArray(config.scopes) || config.scopes.length === 0) {
    missing.push("scopes");
  }
  if (typeof config.publicClient !== "boolean") {
    missing.push("publicClient");
  }

  return missing;
}

function mergeOAuthProviderConfig(input: {
  sourceType: ErrorSourceType;
  pluginConfig?: Partial<OAuthProviderConfig>;
}): OAuthProviderConfig {
  if (input.pluginConfig === undefined) {
    throw new Error(
      `OAuth is not configured for source type: ${input.sourceType}`,
    );
  }

  const missingKeys = readMissingOAuthProviderConfigKeys(input.pluginConfig);
  if (missingKeys.length > 0) {
    throw new Error(
      `OAuth config for source type "${input.sourceType}" is incomplete. Missing: ${missingKeys.join(", ")}`,
    );
  }

  const config = input.pluginConfig as OAuthProviderConfig;
  return {
    envClientIdName: config.envClientIdName,
    envClientSecretName: config.envClientSecretName,
    envRedirectUriName: config.envRedirectUriName,
    defaultRedirectUri: config.defaultRedirectUri,
    scopes: config.scopes,
    publicClient: config.publicClient,
  };
}

function isExpired(createdAt: string): boolean {
  const createdAtMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) return true;
  return Date.now() - createdAtMs > OAUTH_STATE_TTL_MS;
}

function readBaseUrl(input: { baseUrl?: string } | undefined): string | undefined {
  const raw = input?.baseUrl?.trim() ?? "";
  if (raw.length === 0) {
    return undefined;
  }
  return raw;
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

export interface DesktopOauthManagerBindings {
  OauthManagerService: new (
    db: DesktopOAuthSettingsDatabase,
    pluginRuntime?: DesktopPluginRuntimeService,
  ) => DesktopOauthManagerService;
}

export function createDesktopOauthManagerBindings(
  defaultRedirectUri?: string,
): DesktopOauthManagerBindings {
  class BoundDesktopOauthManagerService extends DesktopOauthManagerService {
    constructor(
      db: DesktopOAuthSettingsDatabase,
      pluginRuntime?: DesktopPluginRuntimeService,
    ) {
      super(db, pluginRuntime, { defaultRedirectUri });
    }
  }

  return {
    OauthManagerService: BoundDesktopOauthManagerService,
  };
}

type DesktopOauthManagerOptions = {
  defaultRedirectUri?: string;
};

export class DesktopOauthManagerService {
  constructor(
    private readonly db: DesktopOAuthSettingsDatabase,
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
    private readonly options: DesktopOauthManagerOptions = {},
  ) {}

  private getProviderConfig(
    sourceType: ErrorSourceType,
    pluginId?: string,
  ): { config: OAuthProviderConfig; pluginId: string } {
    const pluginConfig = resolvePluginOAuthConfig({
      runtime: this.pluginRuntime,
      sourceType,
      pluginId,
    });

    const config = mergeOAuthProviderConfig({
      sourceType,
      pluginConfig: pluginConfig.oauth,
    });
    const defaultRedirectUri = this.options.defaultRedirectUri?.trim();
    let resolvedConfig = config;
    if (defaultRedirectUri !== undefined && defaultRedirectUri.length > 0) {
      resolvedConfig = { ...config, defaultRedirectUri };
    }

    return {
      pluginId: pluginConfig.pluginId,
      config: resolvedConfig,
    };
  }

  async initiateOAuth(
    sourceType: ErrorSourceType,
    input?: InitiateOAuthInput,
  ): Promise<{ state: string; authUrl: string; redirectUri: string }> {
    await this.pruneExpiredPendingStates();

    const pluginId = input?.pluginId?.trim() || undefined;
    const { config, pluginId: resolvedPluginId } = this.getProviderConfig(
      sourceType,
      pluginId,
    );
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

    const providerBaseUrl = readBaseUrl(input);
    const authUrl = await buildPluginAuthorizeUrl({
      runtime: this.pluginRuntime,
      sourceType,
      pluginId: resolvedPluginId,
      baseUrl: providerBaseUrl,
      authorize: {
        clientId,
        redirectUri,
        scopes: config.scopes,
        state,
        codeChallenge,
      },
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
      const { config, pluginId: resolvedPluginId } = this.getProviderConfig(
        sourceType,
        effectivePluginId,
      );
      const pendingBaseUrl = pending.providerBaseUrl;
      const requestedBaseUrl = readBaseUrl(input);
      if (
        pendingBaseUrl !== undefined &&
        requestedBaseUrl !== undefined &&
        pendingBaseUrl !== requestedBaseUrl
      ) {
        throw new Error(
          "OAuth base URL changed between authorization and token exchange",
        );
      }
      const providerBaseUrl = pendingBaseUrl ?? requestedBaseUrl;
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

      const tokens = await exchangePluginCodeForToken({
        runtime: this.pluginRuntime,
        sourceType,
        pluginId: resolvedPluginId,
        baseUrl: providerBaseUrl,
        exchange: {
          clientId,
          clientSecret,
          code: input.code,
          redirectUri,
          codeVerifier: pending.codeVerifier,
        },
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
