export const PLUGIN_BACKED_ERROR_SOURCE_TYPES = [
  "sentry",
  "wazuh",
  "posthog",
] as const;

export type PluginBackedErrorSourceType =
  (typeof PLUGIN_BACKED_ERROR_SOURCE_TYPES)[number];

export const OAUTH_PLUGIN_ERROR_SOURCE_TYPES = [
  "sentry",
  "posthog",
] as const;

export type OAuthPluginErrorSourceType =
  (typeof OAUTH_PLUGIN_ERROR_SOURCE_TYPES)[number];

export const RUNBOOK_QUERY_PLUGIN_ERROR_SOURCE_TYPES = [
  "sentry",
  "posthog",
  "wazuh",
] as const;

export type RunbookQueryPluginErrorSourceType =
  (typeof RUNBOOK_QUERY_PLUGIN_ERROR_SOURCE_TYPES)[number];

export function isPluginBackedErrorSourceType(
  value: string,
): value is PluginBackedErrorSourceType {
  return (
    PLUGIN_BACKED_ERROR_SOURCE_TYPES as readonly string[]
  ).includes(value);
}

export function isOAuthPluginErrorSourceType(
  value: string,
): value is OAuthPluginErrorSourceType {
  return (
    OAUTH_PLUGIN_ERROR_SOURCE_TYPES as readonly string[]
  ).includes(value);
}

export function isRunbookQueryPluginErrorSourceType(
  value: string,
): value is RunbookQueryPluginErrorSourceType {
  return (
    RUNBOOK_QUERY_PLUGIN_ERROR_SOURCE_TYPES as readonly string[]
  ).includes(value);
}
