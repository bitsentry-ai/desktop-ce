import { z } from "zod";

import type { DesktopPluginRuntimeService } from "../plugins";
import type { ErrorSourceType } from "./desktop-error-sources.types";
import type {
  DesktopOAuthAuthorizeInput,
  DesktopOAuthTokenExchangeInput,
  DesktopOAuthTokenResponse,
  OAuthProviderConfig,
} from "./desktop-oauth-manager";
import { resolveErrorSourceProviderActionId } from "./desktop-plugin-error-source-actions";

type OAuthPluginDescriptor = {
  metadata?: {
    dataSource?: {
      sourceType?: ErrorSourceType;
      oauth?: Partial<OAuthProviderConfig>;
    };
  };
};

const oauthAuthorizeUrlResponseSchema = z.object({
  authUrl: z.string().min(1),
});

const oauthTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresIn: z.number().optional(),
  scope: z.string().optional(),
});

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function readPluginId(additionalMetadata: unknown): string | undefined {
  if (
    additionalMetadata === null ||
    additionalMetadata === undefined ||
    typeof additionalMetadata !== "object" ||
    Array.isArray(additionalMetadata)
  ) {
    return undefined;
  }

  return readOptionalString(
    (additionalMetadata as { pluginId?: unknown }).pluginId,
  );
}

function buildOAuthAuth(baseUrl: string | undefined): Record<string, unknown> {
  const auth: Record<string, unknown> = {};
  const normalizedBaseUrl = readOptionalString(baseUrl);
  if (normalizedBaseUrl !== undefined) {
    auth.baseUrl = normalizedBaseUrl;
  }

  return auth;
}

export function resolveErrorSourcePluginId(input: {
  sourceType: ErrorSourceType;
  pluginId?: string;
  additionalMetadata?: unknown;
}): string {
  return (
    readOptionalString(input.pluginId) ??
    readPluginId(input.additionalMetadata) ??
    input.sourceType
  );
}

export function resolvePluginOAuthConfig(input: {
  runtime: Pick<DesktopPluginRuntimeService, "getPlugin">;
  sourceType: ErrorSourceType;
  pluginId?: string;
  additionalMetadata?: unknown;
}): {
  pluginId: string;
  plugin: OAuthPluginDescriptor | null;
  oauth?: Partial<OAuthProviderConfig>;
} {
  const pluginId = resolveErrorSourcePluginId(input);
  const plugin = input.runtime.getPlugin(pluginId);
  if (plugin?.metadata?.dataSource?.sourceType !== input.sourceType) {
    return { pluginId, plugin };
  }

  return {
    pluginId,
    plugin,
    oauth: plugin.metadata.dataSource.oauth,
  };
}

export async function buildPluginAuthorizeUrl(input: {
  runtime: DesktopPluginRuntimeService;
  sourceType: ErrorSourceType;
  pluginId: string;
  baseUrl?: string;
  authorize: DesktopOAuthAuthorizeInput;
}): Promise<string> {
  const result = await input.runtime.executeAction({
    pluginId: input.pluginId,
    actionId: resolveErrorSourceProviderActionId({
      runtime: input.runtime,
      pluginId: input.pluginId,
      sourceType: input.sourceType,
      action: "buildAuthorizeUrl",
    }),
    auth: buildOAuthAuth(input.baseUrl),
    input: {
      clientId: input.authorize.clientId,
      redirectUri: input.authorize.redirectUri,
      scopes: input.authorize.scopes,
      state: input.authorize.state,
      codeChallenge: input.authorize.codeChallenge,
    },
  });

  if (!result.ok) {
    throw new Error(result.summary);
  }

  return oauthAuthorizeUrlResponseSchema.parse(result.data).authUrl;
}

export async function exchangePluginCodeForToken(input: {
  runtime: DesktopPluginRuntimeService;
  sourceType: ErrorSourceType;
  pluginId: string;
  baseUrl?: string;
  exchange: DesktopOAuthTokenExchangeInput;
}): Promise<DesktopOAuthTokenResponse> {
  void input.exchange.signal;

  const result = await input.runtime.executeAction({
    pluginId: input.pluginId,
    actionId: resolveErrorSourceProviderActionId({
      runtime: input.runtime,
      pluginId: input.pluginId,
      sourceType: input.sourceType,
      action: "exchangeCodeForToken",
    }),
    auth: buildOAuthAuth(input.baseUrl),
    input: {
      clientId: input.exchange.clientId,
      clientSecret: input.exchange.clientSecret,
      code: input.exchange.code,
      redirectUri: input.exchange.redirectUri,
      codeVerifier: input.exchange.codeVerifier,
    },
  });

  if (!result.ok) {
    throw new Error(result.summary);
  }

  return oauthTokenResponseSchema.parse(result.data);
}

export async function refreshPluginAccessToken(input: {
  runtime: DesktopPluginRuntimeService;
  sourceType: ErrorSourceType;
  pluginId: string;
  baseUrl?: string;
  refresh: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    signal?: AbortSignal;
  };
}): Promise<DesktopOAuthTokenResponse> {
  void input.refresh.signal;

  const result = await input.runtime.executeAction({
    pluginId: input.pluginId,
    actionId: resolveErrorSourceProviderActionId({
      runtime: input.runtime,
      pluginId: input.pluginId,
      sourceType: input.sourceType,
      action: "refreshToken",
    }),
    auth: buildOAuthAuth(input.baseUrl),
    input: {
      clientId: input.refresh.clientId,
      clientSecret: input.refresh.clientSecret,
      refreshToken: input.refresh.refreshToken,
    },
  });

  if (!result.ok) {
    throw new Error(result.summary);
  }

  return oauthTokenResponseSchema.parse(result.data);
}
