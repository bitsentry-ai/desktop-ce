import type { ErrorSourceType } from "./desktop-error-sources.types";
import type { DesktopPluginRuntimeService } from "../plugins";
import type { PluginBackedErrorSourceType } from "./plugin-backed-error-sources";

export type ErrorSourceProviderActionKey =
  | "listOrganizations"
  | "listProjects"
  | "getProject"
  | "queryIssues"
  | "listIssues"
  | "listIssueEvents"
  | "searchAlerts";

const DEFAULT_PROVIDER_ACTIONS: Record<
  PluginBackedErrorSourceType,
  Partial<Record<ErrorSourceProviderActionKey, string>>
> = {
  sentry: {
    listOrganizations: "list_organizations",
    listProjects: "list_projects",
    queryIssues: "query_issues",
    listIssues: "list_issues",
    listIssueEvents: "list_issue_events",
  },
  posthog: {
    listOrganizations: "list_organizations",
    listProjects: "list_projects",
    getProject: "get_project",
    queryIssues: "query_issues",
    listIssues: "list_issues",
    listIssueEvents: "list_issue_events",
  },
  wazuh: {
    searchAlerts: "search_alerts",
  },
};

export function resolveErrorSourceProviderActionId(input: {
  runtime: DesktopPluginRuntimeService;
  pluginId: string;
  sourceType: ErrorSourceType;
  action: ErrorSourceProviderActionKey;
}): string {
  const plugin = input.runtime.getPlugin(input.pluginId);
  const configured =
    plugin?.metadata?.errorSource?.providerActions?.[input.action];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }

  if (input.sourceType in DEFAULT_PROVIDER_ACTIONS) {
    const fallback =
      DEFAULT_PROVIDER_ACTIONS[input.sourceType as PluginBackedErrorSourceType][
        input.action
      ];
    if (typeof fallback === "string" && fallback.trim().length > 0) {
      return fallback;
    }
  }

  throw new Error(
    `Plugin "${input.pluginId}" does not declare a provider action for "${input.action}".`,
  );
}
