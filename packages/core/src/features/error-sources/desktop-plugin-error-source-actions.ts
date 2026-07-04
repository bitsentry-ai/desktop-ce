import type { ErrorSourceType } from "./desktop-error-sources.types";
import type { DesktopPluginDescriptor, DesktopPluginRuntimeService } from "../plugins";

export type ErrorSourceProviderActionKey =
  | "buildAuthorizeUrl"
  | "exchangeCodeForToken"
  | "refreshToken"
  | "listOrganizations"
  | "listProjects"
  | "getProject"
  | "queryIssues"
  | "listIssues"
  | "listIssueEvents"
  | "searchAlerts";

function toSnakeCase(action: ErrorSourceProviderActionKey): string {
  return action.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function resolveConventionalActionId(
  plugin: DesktopPluginDescriptor,
  action: ErrorSourceProviderActionKey,
): string | undefined {
  const snakeCaseAction = toSnakeCase(action);
  const match = plugin.actions.find(
    (candidate) => candidate.id === action || candidate.id === snakeCaseAction,
  );

  return match?.id;
}

export function hasErrorSourceProviderAction(
  plugin: DesktopPluginDescriptor,
  action: ErrorSourceProviderActionKey,
): boolean {
  return resolveConventionalActionId(plugin, action) !== undefined;
}

export function resolveErrorSourceProviderActionId(input: {
  runtime: DesktopPluginRuntimeService;
  pluginId: string;
  sourceType: ErrorSourceType;
  action: ErrorSourceProviderActionKey;
}): string {
  const plugin = input.runtime.getPlugin(input.pluginId);
  if (plugin?.metadata?.dataSource?.sourceType === input.sourceType) {
    const actionId = resolveConventionalActionId(plugin, input.action);
    if (actionId !== undefined) {
      return actionId;
    }
  }

  throw new Error(
    `Plugin "${input.pluginId}" does not declare a provider action for "${input.action}".`,
  );
}
