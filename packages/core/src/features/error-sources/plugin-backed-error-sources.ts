export const OAUTH_PLUGIN_ERROR_SOURCE_TYPES = [
  "sentry",
  "posthog",
] as const;

export type OAuthPluginErrorSourceType =
  (typeof OAUTH_PLUGIN_ERROR_SOURCE_TYPES)[number];

export function isOAuthPluginErrorSourceType(
  value: string,
): value is OAuthPluginErrorSourceType {
  return (
    OAUTH_PLUGIN_ERROR_SOURCE_TYPES as readonly string[]
  ).includes(value);
}
