import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  useCreateErrorSource,
  useDeleteErrorSource,
  useErrorSources,
  usePlugins,
  useSyncErrorSource,
  useSystemSettings,
  useUpdateErrorSource,
  useUpdateSystemSettings,
} from "../services/hooks";
import { toast } from "sonner";
import type {
  CreateErrorSourceInput,
  ErrorSourceType,
  PluginErrorSourceSetupField,
  ErrorSourceRow,
  LogLevelThreshold,
  PluginManifest,
} from "../services/contracts";
import { useTranslation } from "@bitsentry-ce/i18n";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { ProviderIcon, type ProviderIconKind } from "./icons";

type StatusKind = "info" | "success" | "error";
type Translate = (key: string, options?: Record<string, unknown>) => string;

function normalizeSyncErrorMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) return "Unknown error";

  if (/worker api error:\s*not found/i.test(normalized)) {
    return "Worker service endpoint is unavailable.";
  }

  return normalized;
}

function toMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return normalizeSyncErrorMessage(error.message);
  }

  if (typeof error === "object" && error !== null) {
    if (
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim().length > 0
    ) {
      return normalizeSyncErrorMessage(error.message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      /* no-op */
    }
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return normalizeSyncErrorMessage(error);
  }

  return "Unknown error";
}

function formatStoredSyncErrorMessage(error: unknown, t: Translate): string {
  const message = toMessage(error);
  if (message.trim().length === 0) {
    return t("common.errorSourcesManager.unknownSyncError");
  }

  if (message === "Worker service endpoint is unavailable.") {
    return t("common.errorSourcesManager.workerEndpointUnavailable");
  }

  const match = /^(PostHog|Sentry) API (\d+):\s*(.*)$/i.exec(message);
  if (match === null) return message;

  let provider = t("common.errorSourcesManager.sentryProviderName");
  if (match[1].toLowerCase() === "posthog") {
    provider = t("common.errorSourcesManager.posthogProviderName");
  }
  const prefix = t("common.errorSourcesManager.apiErrorDetail", {
    provider,
    status: match[2],
  });
  const detail = match[3].trim();
  if (detail.length > 0) {
    return `${prefix}: ${detail}`;
  }

  return prefix;
}

function toProjectSlugs(raw: string): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const part of raw.split(/[,\n]/g)) {
    const slug = part.trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    output.push(slug);
  }
  return output;
}

function formatDate(value: string | null, t: (key: string) => string): string {
  if (value === null || value.length === 0) {
    return t("common.errorSourcesManager.never");
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatSyncStatus(
  value: string | null | undefined,
  t: (key: string) => string,
): string {
  switch (value) {
    case "in_progress":
      return t("common.errorSourcesManager.syncInProgress");
    case "success":
      return t("common.errorSourcesManager.lastSyncSucceeded");
    case "failed":
      return t("common.errorSourcesManager.lastSyncFailed");
    default:
      if (value !== undefined && value !== null && value.length > 0) {
        return value.replace(/_/g, " ");
      }

      return "";
  }
}

function formatSyncSummary(
  source: ErrorSourceRow,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts = [
    t("common.errorSourcesManager.lastSyncAt", {
      value: formatDate(source.lastSyncAt, t),
    }),
  ];
  const status = formatSyncStatus(source.lastSyncStatus, t);
  if (status.length > 0) parts.push(status);
  return parts.join(" - ");
}

function normalizeLastUsedExternalSourceId(
  value: string | null | undefined,
): string {
  if (value === undefined || value === null) {
    return "";
  }

  return value.trim();
}

function toProviderIconKind(sourceType: ErrorSourceType): ProviderIconKind {
  if (sourceType === "sentry" || sourceType === "wazuh" || sourceType === "posthog") {
    return sourceType;
  }

  return "plugin";
}

function readPluginErrorSourceType(
  plugin: PluginManifest,
): ErrorSourceType | null {
  return plugin.metadata?.errorSource?.sourceType ?? null;
}

function readPluginErrorSourceSetupField(
  plugin: PluginManifest | null,
  target: PluginErrorSourceSetupField["target"],
): PluginErrorSourceSetupField | null {
  const setupFields = plugin?.metadata?.errorSource?.setupFields;
  if (setupFields === undefined) {
    return null;
  }

  return setupFields.find((field) => field.target === target) ?? null;
}

function formatSetupFieldRequiredMessage(label: string): string {
  return `${label} is required.`;
}

function formatCustomHostRequiredMessage(label: string): string {
  return `${label} is required when using a custom host.`;
}

function readSourcePluginId(source: ErrorSourceRow): string {
  if (typeof source.pluginId === "string" && source.pluginId.trim().length > 0) {
    return source.pluginId.trim();
  }

  return source.sourceType;
}

function findPluginManifestForSource(
  plugins: PluginManifest[],
  source: ErrorSourceRow,
): PluginManifest | null {
  const pluginId = readSourcePluginId(source);
  return (
    plugins.find((plugin) => plugin.id === pluginId) ??
    plugins.find((plugin) => readPluginErrorSourceType(plugin) === source.sourceType) ??
    null
  );
}

function readArrayDisplayValue(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value.filter((item): item is string => typeof item === "string").join(", ");
}

function readPluginSetupFieldDisplayValue(
  source: ErrorSourceRow,
  field: PluginErrorSourceSetupField,
): string {
  const config = source.configuration;
  if (config === undefined) {
    return "";
  }

  const key = field.configurationKey ?? field.key;

  switch (field.target) {
    case "organizationSlug":
    case "organizationId":
      return readStringFromConfig(config, "orgSlug");
    case "projectSlugs":
      return readStringArrayFromConfig(config, "projectSlugs");
    case "projectIds": {
      const configuredProjectIds = readStringArrayFromConfig(config, "projectIds");
      if (configuredProjectIds.length > 0) {
        return configuredProjectIds;
      }

      return readStringArrayFromConfig(config, "projectSlugs");
    }
    case "baseUrl": {
      if (source.sourceType === "posthog") {
        return (
          readStringFromConfig(config, "posthogBaseUrl") ||
          readStringFromConfig(config, "baseUrl")
        );
      }

      return readStringFromConfig(config, "baseUrl");
    }
    case "indexPatterns":
      return readStringArrayFromConfig(config, "indexPatterns");
    case "authToken":
      return "";
    default: {
      const value = config[key];
      if (typeof value === "string") {
        return value;
      }
      if (Array.isArray(value)) {
        return readArrayDisplayValue(value);
      }
      if (value !== null && typeof value === "object") {
        return JSON.stringify(value);
      }
      return "";
    }
  }
}

function buildInitialEditSetupFieldValues(
  source: ErrorSourceRow,
  plugin: PluginManifest | null,
): Record<string, string> {
  const setupFields = plugin?.metadata?.errorSource?.setupFields ?? [];
  return Object.fromEntries(
    setupFields.map((field) => [field.key, readPluginSetupFieldDisplayValue(source, field)]),
  );
}

function renderLegacyEditConnectionFields(
  source: ErrorSourceRow,
  t: (key: string) => string,
): ReactNode {
  const config = source.configuration;

  if (source.sourceType === "sentry") {
    return (
      <>
        <div className="space-y-1">
          <FieldLabel>
            {t("common.errorSourcesManager.labelOrganization")}
          </FieldLabel>
          <Input
            value={readStringFromConfig(config, "orgSlug")}
            readOnly
            disabled
          />
        </div>
        <div className="space-y-1">
          <FieldLabel>
            {t("common.errorSourcesManager.labelProjects")}
          </FieldLabel>
          <Input
            value={readStringArrayFromConfig(config, "projectSlugs")}
            readOnly
            disabled
          />
        </div>
      </>
    );
  }

  if (source.sourceType === "posthog") {
    return (
      <>
        <div className="space-y-1">
          <FieldLabel>
            {t("common.errorSourcesManager.labelPosthogHost")}
          </FieldLabel>
          <Input
            value={readStringFromConfig(config, "posthogBaseUrl")}
            readOnly
            disabled
          />
        </div>
        <div className="space-y-1">
          <FieldLabel>
            {t("common.errorSourcesManager.labelOrganization")}
          </FieldLabel>
          <Input
            value={readStringFromConfig(config, "orgSlug")}
            readOnly
            disabled
          />
        </div>
        <div className="space-y-1">
          <FieldLabel>
            {t("common.errorSourcesManager.labelProjects")}
          </FieldLabel>
          <Input
            value={readStringArrayFromConfig(config, "projectIds")}
            readOnly
            disabled
          />
        </div>
      </>
    );
  }

  return (
    <>
      <div className="space-y-1">
        <FieldLabel>
          {t("common.errorSourcesManager.labelApiBaseUrl")}
        </FieldLabel>
        <Input
          value={readStringFromConfig(config, "baseUrl")}
          readOnly
          disabled
        />
      </div>
      <div className="space-y-1">
        <FieldLabel>
          {t("common.errorSourcesManager.labelIndexPatterns")}
        </FieldLabel>
        <Input
          value={readStringArrayFromConfig(config, "indexPatterns")}
          readOnly
          disabled
        />
      </div>
    </>
  );
}

interface ErrorSourcesManagerProps {
  showHeader?: boolean;
}

interface FieldLabelProps {
  children: ReactNode;
  required?: boolean;
}

interface ProviderCard {
  pluginId: string;
  sourceType: ErrorSourceType;
  label: string;
  icon: ProviderIconKind;
}

function readProviderSortOrder(sourceType: ErrorSourceType): number {
  if (sourceType === "sentry") return 0;
  if (sourceType === "wazuh") return 1;
  if (sourceType === "posthog") return 2;
  return 99;
}

function FieldLabel({ children, required = false }: FieldLabelProps) {
  let requiredMarker: ReactNode = null;
  if (required) {
    requiredMarker = <span className="ml-0.5 text-red-600">*</span>;
  }

  return (
    <label className="text-sm text-muted-foreground">
      {children}
      {requiredMarker}
    </label>
  );
}

// Native <select> paints its caret flush with the right border regardless
// of `pr-*`. Wrap the select in `relative`, give it `appearance-none` +
// padding for the icon, and overlay this chevron — `currentColor` works
// here (the svg is in the DOM), so it adapts to light/dark themes.
function SelectChevron() {
  return (
    <svg
      className="pointer-events-none absolute right-3 top-1/2 size-3 -translate-y-1/2 text-muted-foreground"
      viewBox="0 0 12 8"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="1,1.5 6,6.5 11,1.5" />
    </svg>
  );
}

export default function ErrorSourcesManager({
  showHeader = true,
}: ErrorSourcesManagerProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{
    kind: StatusKind;
    message: string;
  } | null>(null);

  // ---- Create-source dialog state ----
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [sourceType, setSourceType] = useState<ErrorSourceType>("sentry");
  const [selectedProviderId, setSelectedProviderId] = useState("sentry");
  const [sourceName, setSourceName] = useState("Sentry");
  const [authToken, setAuthToken] = useState("");

  // Wazuh-only state (no probe — Wazuh has no orgs/projects concept).
  const [wazuhBaseUrl, setWazuhBaseUrl] = useState("");
  const [indexPatternsText, setIndexPatternsText] = useState("");

  // PostHog base URL state (still needed for Step 1 — the probe must know
  // which PostHog host to hit).
  const [posthogBaseUrlMode, setPosthogBaseUrlMode] = useState<
    "us" | "eu" | "custom"
  >("us");
  const [posthogCustomBaseUrl, setPosthogCustomBaseUrl] = useState("");

  // Manual org/project entry. A probe-then-pick flow used to live here but
  // the picker UI was never wired up to a button, so callers always typed
  // org/project ids directly. The names retain the `advanced*` prefix
  // because they bind to the same inputs the user already sees.
  const [advancedOrgInput, setAdvancedOrgInput] = useState("");
  const [advancedProjectsInput, setAdvancedProjectsInput] = useState("");
  const [customSetupFieldValues, setCustomSetupFieldValues] = useState<
    Record<string, string>
  >({});

  const [logLevelThreshold, setLogLevelThreshold] =
    useState<LogLevelThreshold>("error");
  const [syncEnabledOnCreate, setSyncEnabledOnCreate] = useState(true);

  // Errors that belong INSIDE the create-source dialog (probe failures,
  // validation, save errors). Rendering them on the page-level banner makes
  // the error appear behind the modal, which is confusing.
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Log level + sync defaults are sensible for almost everyone, so collapse
  // them behind an "Advanced" disclosure to keep the dialog short enough to
  // fit on small viewports.
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [pendingSyncs, setPendingSyncs] = useState<
    Record<string, { name: string }>
  >({});

  // ---- Edit-source dialog state ----
  const [editDialogSource, setEditDialogSource] =
    useState<ErrorSourceRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editLogThreshold, setEditLogThreshold] =
    useState<LogLevelThreshold>("error");
  const [editSyncEnabled, setEditSyncEnabled] = useState(true);
  const [editSetupFieldValues, setEditSetupFieldValues] = useState<
    Record<string, string>
  >({});
  const [editDialogError, setEditDialogError] = useState<string | null>(null);

  const {
    data: sources = [],
    isLoading,
    refetch: refetchSources,
  } = useErrorSources();
  const { data: plugins = [] } = usePlugins();
  const { data: systemSettings } = useSystemSettings();
  const createMutation = useCreateErrorSource();
  const deleteMutation = useDeleteErrorSource();
  const syncMutation = useSyncErrorSource();
  const updateMutation = useUpdateErrorSource();
  const updateSystemSettingsMutation = useUpdateSystemSettings();

  const lastUsedExternalSourceId = normalizeLastUsedExternalSourceId(
    systemSettings?.lastUsedExternalSourceId,
  );

  const pendingSyncIds = useMemo(
    () => new Set(Object.keys(pendingSyncs)),
    [pendingSyncs],
  );
  const actionLoading =
    createMutation.isPending ||
    deleteMutation.isPending ||
    updateMutation.isPending ||
    updateSystemSettingsMutation.isPending;
  const posthogProjectIds = useMemo(
    () => toProjectSlugs(advancedProjectsInput),
    [advancedProjectsInput],
  );
  const providerCards = useMemo<ProviderCard[]>(
    () => {
      const discovered = plugins
        .flatMap((plugin) => {
          const pluginSourceType = readPluginErrorSourceType(plugin);
          if (pluginSourceType === null) {
            return [];
          }

          return [
            {
              pluginId: plugin.id,
              sourceType: pluginSourceType,
              label: plugin.name,
              icon: toProviderIconKind(pluginSourceType),
            },
          ];
        })
        .sort((left, right) => {
          const sourceTypeOrder =
            readProviderSortOrder(left.sourceType) -
            readProviderSortOrder(right.sourceType);
          if (sourceTypeOrder !== 0) {
            return sourceTypeOrder;
          }

          const labelOrder = left.label.localeCompare(right.label);
          if (labelOrder !== 0) {
            return labelOrder;
          }

          return left.pluginId.localeCompare(right.pluginId);
        });

      if (discovered.length > 0) {
        return discovered;
      }

      return [
        {
          pluginId: "sentry",
          sourceType: "sentry" as const,
          label: "Sentry",
          icon: "sentry" as const,
        },
        {
          pluginId: "wazuh",
          sourceType: "wazuh" as const,
          label: "Wazuh",
          icon: "wazuh" as const,
        },
        {
          pluginId: "posthog",
          sourceType: "posthog" as const,
          label: "PostHog",
          icon: "posthog" as const,
        },
      ];
    },
    [plugins],
  );
  const selectedProviderCard = useMemo(
    () =>
      providerCards.find((card) => card.pluginId === selectedProviderId) ??
      null,
    [providerCards, selectedProviderId],
  );
  const availableProviderSummary = useMemo(
    () => providerCards.map((card) => card.label).join(", "),
    [providerCards],
  );
  const pluginsById = useMemo(
    () => new Map(plugins.map((plugin) => [plugin.id, plugin])),
    [plugins],
  );
  const selectedPlugin = useMemo(
    () =>
      plugins.find((plugin) => plugin.id === selectedProviderId) ??
      plugins.find((plugin) => readPluginErrorSourceType(plugin) === sourceType) ??
      null,
    [plugins, selectedProviderId, sourceType],
  );
  const selectedSetupFields = useMemo(
    () => selectedPlugin?.metadata?.errorSource?.setupFields ?? [],
    [selectedPlugin],
  );
  const authSetupField = useMemo(
    () => readPluginErrorSourceSetupField(selectedPlugin, "authToken"),
    [selectedPlugin],
  );
  const baseUrlSetupField = useMemo(
    () => readPluginErrorSourceSetupField(selectedPlugin, "baseUrl"),
    [selectedPlugin],
  );
  const orgSetupField = useMemo(
    () =>
      readPluginErrorSourceSetupField(selectedPlugin, "organizationSlug") ??
      readPluginErrorSourceSetupField(selectedPlugin, "organizationId"),
    [selectedPlugin],
  );
  const projectsSetupField = useMemo(
    () =>
      readPluginErrorSourceSetupField(selectedPlugin, "projectSlugs") ??
      readPluginErrorSourceSetupField(selectedPlugin, "projectIds"),
    [selectedPlugin],
  );
  const indexPatternsSetupField = useMemo(
    () => readPluginErrorSourceSetupField(selectedPlugin, "indexPatterns"),
    [selectedPlugin],
  );
  const customSetupFields = useMemo(
    () => selectedSetupFields.filter((field) => field.target === undefined),
    [selectedSetupFields],
  );
  const editDialogPlugin = useMemo(
    () =>
      editDialogSource === null
        ? null
        : findPluginManifestForSource(plugins, editDialogSource),
    [editDialogSource, plugins],
  );

  useEffect(() => {
    if (pendingSyncIds.size === 0) return;

    void refetchSources();
    const intervalId = window.setInterval(() => {
      void refetchSources();
    }, 2_000);

    return () => { window.clearInterval(intervalId); };
  }, [pendingSyncIds, refetchSources]);

  useEffect(() => {
    if (selectedProviderCard !== null) {
      if (selectedProviderCard.sourceType !== sourceType) {
        setSourceType(selectedProviderCard.sourceType);
      }
      return;
    }

    const fallbackCard =
      providerCards.find((card) => card.sourceType === sourceType) ??
      providerCards[0];
    if (fallbackCard !== undefined) {
      setSelectedProviderId(fallbackCard.pluginId);
      if (fallbackCard.sourceType !== sourceType) {
        setSourceType(fallbackCard.sourceType);
      }
    }
  }, [providerCards, selectedProviderCard, sourceType]);

  function resetCreateDialog() {
    setAuthToken("");
    setIndexPatternsText("");
    setWazuhBaseUrl("");
    setPosthogCustomBaseUrl("");
    setPosthogBaseUrlMode("us");
    setAdvancedOrgInput("");
    setAdvancedProjectsInput("");
    setCustomSetupFieldValues({});
    setDialogError(null);
    setShowAdvanced(false);
    setLogLevelThreshold("error");
    setSyncEnabledOnCreate(true);
  }

  function getPosthogResolvedBaseUrl(): string {
    if (posthogBaseUrlMode === "us") return "https://us.posthog.com";
    if (posthogBaseUrlMode === "eu") return "https://eu.posthog.com";
    return posthogCustomBaseUrl.trim();
  }

  function readSetupFieldTextValue(
    field: PluginErrorSourceSetupField,
  ): string {
    switch (field.target) {
      case "authToken":
        return authToken.trim();
      case "organizationSlug":
      case "organizationId":
        return advancedOrgInput.trim();
      case "baseUrl":
        if (field.control === "posthog_base_url") {
          return getPosthogResolvedBaseUrl();
        }
        return wazuhBaseUrl.trim();
      default:
        return customSetupFieldValues[field.key]?.trim() ?? "";
    }
  }

  function readSetupFieldListValue(
    field: PluginErrorSourceSetupField,
  ): string[] {
    switch (field.target) {
      case "projectSlugs":
      case "projectIds":
        return toProjectSlugs(advancedProjectsInput);
      case "indexPatterns":
        return toProjectSlugs(indexPatternsText);
      default:
        return toProjectSlugs(customSetupFieldValues[field.key] ?? "");
    }
  }

  function readCreateSourceValidationError(
    trimmedName: string,
  ): string | null {
    if (trimmedName.length === 0) {
      return t("common.errorSourcesManager.sourceNameRequired");
    }

    for (const field of selectedSetupFields) {
      if (field.target === "baseUrl" && field.control === "posthog_base_url") {
        if (
          posthogBaseUrlMode === "custom" &&
          getPosthogResolvedBaseUrl().length === 0
        ) {
          return formatCustomHostRequiredMessage(field.label);
        }
        continue;
      }

      if (!field.required) {
        continue;
      }

      if (
        field.control === "multiline_list" ||
        field.target === "projectSlugs" ||
        field.target === "projectIds" ||
        field.target === "indexPatterns"
      ) {
        if (readSetupFieldListValue(field).length === 0) {
          return formatSetupFieldRequiredMessage(field.label);
        }
        continue;
      }

      if (readSetupFieldTextValue(field).length === 0) {
        return formatSetupFieldRequiredMessage(field.label);
      }
    }

    return null;
  }

  function buildCreateSourceInput(
    trimmedName: string,
  ): CreateErrorSourceInput {
    const setupValues: Record<string, unknown> = {};
    const input: CreateErrorSourceInput = {
      pluginId: selectedPlugin?.id ?? selectedProviderCard?.pluginId ?? sourceType,
      sourceType,
      name: trimmedName,
      setupValues,
      logLevelThreshold,
      syncEnabled: syncEnabledOnCreate,
      autoDiagnosisEnabled: false,
    };

    for (const field of selectedSetupFields) {
      if (
        field.control === "multiline_list" ||
        field.target === "projectSlugs" ||
        field.target === "projectIds" ||
        field.target === "indexPatterns"
      ) {
        setupValues[field.key] = readSetupFieldListValue(field);
      } else {
        const value = readSetupFieldTextValue(field);
        if (value.length > 0 || field.control === "posthog_base_url") {
          setupValues[field.key] = value;
        }
      }

      switch (field.target) {
        case "authToken": {
          const value = readSetupFieldTextValue(field);
          if (value.length > 0) {
            setupValues.authToken = value;
            input.authToken = value;
          }
          break;
        }
        case "organizationSlug": {
          const value = readSetupFieldTextValue(field);
          if (value.length > 0) {
            setupValues.organizationSlug = value;
            input.organizationSlug = value;
          }
          break;
        }
        case "organizationId": {
          const value = readSetupFieldTextValue(field);
          if (value.length > 0) {
            setupValues.organizationId = value;
            input.organizationId = value;
          }
          break;
        }
        case "projectSlugs": {
          const value = readSetupFieldListValue(field);
          setupValues.projectSlugs = value;
          input.projectSlugs = value;
          break;
        }
        case "projectIds": {
          const value = readSetupFieldListValue(field);
          setupValues.projectIds = value;
          input.projectIds = value;
          break;
        }
        case "indexPatterns": {
          const value = readSetupFieldListValue(field);
          setupValues.indexPatterns = value;
          input.indexPatterns = value;
          break;
        }
        case "baseUrl": {
          const value = readSetupFieldTextValue(field);
          if (field.control === "posthog_base_url") {
            input.baseUrl = value;
          } else if (value.length > 0) {
            input.baseUrl = value;
          }
          break;
        }
        default:
          break;
      }
    }

    return input;
  }

  // Submit — uses the typed org/project ids.
  const createSource = async () => {
    const trimmedName = sourceName.trim();
    const validationError = readCreateSourceValidationError(trimmedName);
    if (validationError !== null) {
      setDialogError(validationError);
      return;
    }

    const input = buildCreateSourceInput(trimmedName);

    try {
      const created = await createMutation.mutateAsync(input);
      // Seed the dashboard's last-used source silently so a freshly added
      // source is pre-selected on the next visit. There's no UI surface for
      // this — it's just remembered-selection state.
      if (lastUsedExternalSourceId.length === 0) {
        await updateSystemSettingsMutation.mutateAsync({
          data: { lastUsedExternalSourceId: created.id },
        });
      }
      resetCreateDialog();
      setAddDialogOpen(false);
      toast.success(
        t("common.errorSourcesManager.linkedSource", { name: trimmedName }),
      );
    } catch (err) {
      setDialogError(`Failed to link source: ${toMessage(err)}`);
    }
  };

  const removeSource = async (source: ErrorSourceRow) => {
    const wasLastUsed = source.id === lastUsedExternalSourceId;

    try {
      await deleteMutation.mutateAsync(source.id);

      if (wasLastUsed) {
        await updateSystemSettingsMutation.mutateAsync({
          data: { lastUsedExternalSourceId: null },
        });
      }

      toast.success(
        t("common.errorSourcesManager.removedSource", { name: source.name }),
      );
    } catch (err) {
      setStatus({
        kind: "error",
        message: `Failed to remove source: ${toMessage(err)}`,
      });
    }
  };

  const openEditDialog = (source: ErrorSourceRow) => {
    const plugin = findPluginManifestForSource(plugins, source);
    setEditName(source.name);
    setEditLogThreshold(source.logLevelThreshold ?? "error");
    setEditSyncEnabled(source.syncEnabled);
    setEditSetupFieldValues(buildInitialEditSetupFieldValues(source, plugin));
    setEditDialogError(null);
    setEditDialogSource(source);
  };

  function readEditSetupFieldTextValue(
    field: PluginErrorSourceSetupField,
  ): string {
    return editSetupFieldValues[field.key]?.trim() ?? "";
  }

  function readEditSetupFieldListValue(
    field: PluginErrorSourceSetupField,
  ): string[] {
    return toProjectSlugs(editSetupFieldValues[field.key] ?? "");
  }

  function readEditValidationError(
    source: ErrorSourceRow,
    plugin: PluginManifest | null,
    trimmedName: string,
  ): string | null {
    if (trimmedName.length === 0) {
      return t("common.errorSourcesManager.sourceNameRequired");
    }

    const setupFields = plugin?.metadata?.errorSource?.setupFields ?? [];
    for (const field of setupFields) {
      if (!field.required) {
        continue;
      }

      if (field.target === "authToken" || field.storage === "accessTokenRef") {
        continue;
      }

      if (
        field.control === "multiline_list" ||
        field.target === "projectSlugs" ||
        field.target === "projectIds" ||
        field.target === "indexPatterns"
      ) {
        if (readEditSetupFieldListValue(field).length === 0) {
          return formatSetupFieldRequiredMessage(field.label);
        }
        continue;
      }

      if (readEditSetupFieldTextValue(field).length === 0) {
        return formatSetupFieldRequiredMessage(field.label);
      }
    }

    return null;
  }

  const saveEdit = async () => {
    if (editDialogSource === null) return;
    const source = editDialogSource;
    const plugin = findPluginManifestForSource(plugins, source);
    const trimmedName = editName.trim();
    const validationError = readEditValidationError(source, plugin, trimmedName);
    if (validationError !== null) {
      setEditDialogError(validationError);
      return;
    }

    const setupFields = plugin?.metadata?.errorSource?.setupFields ?? [];
    const setupValues: Record<string, unknown> = {};
    for (const field of setupFields) {
      if (
        field.control === "multiline_list" ||
        field.target === "projectSlugs" ||
        field.target === "projectIds" ||
        field.target === "indexPatterns"
      ) {
        const value = readEditSetupFieldListValue(field);
        if (value.length === 0) {
          continue;
        }
        setupValues[field.key] = value;
        switch (field.target) {
          case "projectSlugs":
            setupValues.projectSlugs = value;
            break;
          case "projectIds":
            setupValues.projectIds = value;
            break;
          case "indexPatterns":
            setupValues.indexPatterns = value;
            break;
          default:
            break;
        }
        continue;
      }

      const value = readEditSetupFieldTextValue(field);
      if (value.length === 0) {
        continue;
      }

      setupValues[field.key] = value;
      switch (field.target) {
        case "authToken":
          setupValues.authToken = value;
          break;
        case "organizationSlug":
          setupValues.organizationSlug = value;
          break;
        case "organizationId":
          setupValues.organizationId = value;
          break;
        case "baseUrl":
          setupValues.baseUrl = value;
          break;
        default:
          break;
      }
    }

    try {
      await updateMutation.mutateAsync({
        id: source.id,
        name: trimmedName,
        setupValues,
        logLevelThreshold: editLogThreshold,
        syncEnabled: editSyncEnabled,
      });
      setEditSetupFieldValues({});
      setEditDialogSource(null);
      toast.success(
        t("common.errorSourcesManager.updatedSource", { name: trimmedName }),
      );
    } catch (err) {
      setEditDialogError(`Failed to update source: ${toMessage(err)}`);
    }
  };

  const runSync = (source: ErrorSourceRow) => {
    setPendingSyncs((current) => ({
      ...current,
      [source.id]: { name: source.name },
    }));

    syncMutation.mutate(
      {
        id: source.id,
        logLevelThreshold: source.logLevelThreshold ?? "error",
        syncEnabled: source.syncEnabled,
      },
      {
        onSuccess: (result) => {
          setPendingSyncs((current) => {
            return Object.fromEntries(
              Object.entries(current).filter(([id]) => id !== source.id),
            );
          });
          void refetchSources();
          toast.success(
            t("common.errorSourcesManager.syncCompleteForSource", {
              source: source.name,
            }),
            {
              description: t("common.errorSourcesManager.syncResultCounts", {
                issues: result.syncedIssues,
                events: result.syncedEvents,
              }),
            },
          );
        },
        onError: (err) => {
          setPendingSyncs((current) => {
            return Object.fromEntries(
              Object.entries(current).filter(([id]) => id !== source.id),
            );
          });
          void refetchSources();
          const message = formatStoredSyncErrorMessage(err, t);
          setStatus({
            kind: "error",
            message: t("common.errorSourcesManager.syncFailedWithMessage", {
              message,
            }),
          });
          toast.error(
            t("common.errorSourcesManager.syncFailedForSource", {
              source: source.name,
            }),
            {
              description: message,
            },
          );
        },
      },
    );
  };

  // ---- Render helpers ----

  let namePlaceholderKey = "common.errorSourcesManager.namePlaceholderPosthog";
  if (sourceType === "sentry") {
    namePlaceholderKey = "common.errorSourcesManager.namePlaceholderSentry";
  } else if (sourceType === "wazuh") {
    namePlaceholderKey = "common.errorSourcesManager.namePlaceholderWazuh";
  }

  let statusContent: ReactNode = null;
  if (status !== null) {
    let statusClassName = "border-blue-300 text-blue-700";
    if (status.kind === "error") {
      statusClassName = "border-red-300 text-red-700";
    } else if (status.kind === "success") {
      statusClassName = "border-green-300 text-green-700";
    }

    statusContent = (
      <div className={`rounded border px-3 py-2 text-sm ${statusClassName}`}>
        {status.message}
      </div>
    );
  }

  let credentialsPageClassName =
    "space-y-4 transition-all duration-300 ease-out translate-x-0 opacity-100";
  let advancedPageClassName =
    "absolute inset-0 space-y-4 transition-all duration-300 ease-out pointer-events-none translate-x-full opacity-0";
  if (showAdvanced) {
    credentialsPageClassName =
      "space-y-4 transition-all duration-300 ease-out pointer-events-none -translate-x-full opacity-0";
    advancedPageClassName =
      "absolute inset-0 space-y-4 transition-all duration-300 ease-out translate-x-0 opacity-100";
  }

  let posthogBaseUrlValue = getPosthogResolvedBaseUrl();
  if (posthogBaseUrlMode === "custom") {
    posthogBaseUrlValue = posthogCustomBaseUrl;
  }

  let authLabelKey = "common.errorSourcesManager.labelAuthToken";
  let authPlaceholderKey = "common.errorSourcesManager.sentryAuthToken";
  let orgPlaceholderKey = "common.errorSourcesManager.organizationSlug";
  let projectsLabelKey = "common.errorSourcesManager.labelProjectsOptional";
  let projectsPlaceholderKey =
    "common.errorSourcesManager.projectSlugsCommaOrNewline";
  if (sourceType === "posthog") {
    authLabelKey = "common.errorSourcesManager.labelApiKey";
    authPlaceholderKey = "common.errorSourcesManager.posthogApiToken";
    orgPlaceholderKey = "common.errorSourcesManager.posthogOrganizationId";
    projectsLabelKey = "common.errorSourcesManager.labelProjects";
    projectsPlaceholderKey = "common.errorSourcesManager.posthogProjectIds";
  }
  const authLabel = authSetupField?.label ?? t(authLabelKey);
  const authPlaceholder =
    authSetupField?.placeholder ?? t(authPlaceholderKey);
  const authDescription = authSetupField?.description;
  const orgLabel =
    orgSetupField?.label ?? t("common.errorSourcesManager.labelOrganization");
  const orgPlaceholder =
    orgSetupField?.placeholder ?? t(orgPlaceholderKey);
  const orgDescription = orgSetupField?.description;
  const orgRequired = orgSetupField?.required ?? sourceType === "sentry";
  const projectsLabel = projectsSetupField?.label ?? t(projectsLabelKey);
  const projectsPlaceholder =
    projectsSetupField?.placeholder ?? t(projectsPlaceholderKey);
  const projectsDescription = projectsSetupField?.description;
  const projectsRequired =
    projectsSetupField?.required ?? sourceType === "posthog";
  const baseUrlLabel =
    baseUrlSetupField?.label ??
    t(
      sourceType === "posthog"
        ? "common.errorSourcesManager.labelPosthogHost"
        : "common.errorSourcesManager.labelApiBaseUrl",
    );
  const baseUrlDescription = baseUrlSetupField?.description;
  const baseUrlPlaceholder =
    baseUrlSetupField?.placeholder ??
    t("common.errorSourcesManager.wazuhBaseUrlOptional");
  const indexPatternsLabel =
    indexPatternsSetupField?.label ??
    t("common.errorSourcesManager.labelIndexPatterns");
  const indexPatternsPlaceholder =
    indexPatternsSetupField?.placeholder ??
    t("common.errorSourcesManager.wazuhAlerts");
  const indexPatternsDescription = indexPatternsSetupField?.description;
  const createSourceDisabled =
    actionLoading || readCreateSourceValidationError(sourceName.trim()) !== null;

  let createButtonLabel = t("common.errorSourcesManager.saveSource");
  if (createMutation.isPending) {
    createButtonLabel = t("common.errorSourcesManager.connecting");
  }

  let editDialogErrorContent: ReactNode = null;
  if (editDialogError !== null && editDialogError.length > 0) {
    editDialogErrorContent = (
      <div
        role="alert"
        className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
      >
        {editDialogError}
      </div>
    );
  }

  let saveEditLabel = t("common.actions.saveChanges");
  if (updateMutation.isPending) {
    saveEditLabel = t("common.actions.saving");
  }

  return (
    <div className="space-y-4">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              {t("common.errorSourcesManager.externalSources")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("common.errorSourcesManager.connectExternalServicesToFeed")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setAddDialogOpen(true); }}
            disabled={actionLoading}
            data-tour="data-sources-add-source"
          >
            {t("common.errorSourcesManager.addSource")}
          </Button>
        </div>
      )}
      {!showHeader && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setAddDialogOpen(true); }}
            disabled={actionLoading}
            data-tour="data-sources-add-source"
          >
            {t("common.errorSourcesManager.addSource_2")}
          </Button>
        </div>
      )}

      {statusContent}

      {isLoading && (
        <p className="text-sm text-muted-foreground">
          {t("common.errorSourcesManager.loadingExternalSources")}
        </p>
      )}
      {!isLoading && sources.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("common.errorSourcesManager.noExternalSourcesConnected")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {availableProviderSummary.length > 0
              ? `Available plugin-backed sources: ${availableProviderSummary}.`
              : t("common.errorSourcesManager.addASentryWazuhOrPostHog")}
          </p>
        </div>
      )}
      {!isLoading && sources.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border">
          {sources.map((source) => {
            const sourcePluginName = pluginsById.get(readSourcePluginId(source))?.name;
            const normalizedPluginName = sourcePluginName?.trim().toLowerCase() ?? "";
            const showPluginNameBadge =
              normalizedPluginName.length > 0 &&
              normalizedPluginName !== source.sourceType.trim().toLowerCase();
            const sourceIsSyncing =
              pendingSyncIds.has(source.id) ||
              source.lastSyncStatus === "in_progress";
            let syncSummary = formatSyncSummary(source, t);
            if (sourceIsSyncing) {
              syncSummary = t("common.errorSourcesManager.syncing");
            }

            let lastSyncErrorContent: ReactNode = null;
            if (
              source.lastSyncError !== null &&
              source.lastSyncError.length > 0 &&
              !sourceIsSyncing
            ) {
              lastSyncErrorContent = (
                <span className="text-red-600">
                  {" "}
                  - {formatStoredSyncErrorMessage(source.lastSyncError, t)}
                </span>
              );
            }

            let refreshClassName: string | undefined;
            if (sourceIsSyncing) {
              refreshClassName = "animate-spin";
            }

            return (
              <div key={source.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {source.name}
                    </span>
                    {showPluginNameBadge && (
                      <Badge variant="secondary">
                        {sourcePluginName}
                      </Badge>
                    )}
                    <Badge variant="secondary">{source.sourceType}</Badge>
                    {source.syncEnabled && (
                      <Badge variant="secondary">
                        {t("common.errorSourcesManager.autoSyncOn")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {syncSummary}
                    {lastSyncErrorContent}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { openEditDialog(source); }}
                    disabled={actionLoading}
                    aria-label={t("common.errorSourcesManager.editSource")}
                    title={t("common.errorSourcesManager.editSource")}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <Pencil size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { runSync(source); }}
                    disabled={
                      actionLoading ||
                      pendingSyncIds.has(source.id) ||
                      source.lastSyncStatus === "in_progress"
                    }
                    aria-label={t("common.errorSourcesManager.syncNow")}
                    title={t("common.errorSourcesManager.syncNow")}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    <RefreshCw
                      size={16}
                      aria-hidden="true"
                      className={refreshClassName}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeSource(source)}
                    disabled={actionLoading}
                    aria-label={t("common.errorSourcesManager.removeSource")}
                    title={t("common.errorSourcesManager.removeSource_2")}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-red-600 disabled:opacity-50"
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          setAddDialogOpen(open);
          if (!open) resetCreateDialog();
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t("common.errorSourcesManager.connectExternalSource")}
            </DialogTitle>
            <DialogDescription>
              {t(
                "common.errorSourcesManager.connectAnErrorTrackingIntegration",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Provider picker — SVG card grid, replaces the plain <select>. */}
            <div data-tour="data-sources-provider-picker" className="space-y-2">
              <label className="text-sm text-muted-foreground">
                {t("common.errorSourcesManager.sourceType")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {providerCards.map((card) => {
                  const selected = selectedProviderId === card.pluginId;
                  let cardClassName = "border-border bg-card hover:border-primary/50";
                  if (selected) {
                    cardClassName = "border-primary bg-primary/10 ring-1 ring-primary";
                  }
                  let iconClassName = t(
                    "common.errorSourcesManager.opacity40GrayscaleTransition",
                  );
                  if (selected) {
                    iconClassName = "transition";
                  }

                  return (
                    <button
                      key={card.pluginId}
                      type="button"
                      onClick={() => {
                        setSelectedProviderId(card.pluginId);
                        setSourceType(card.sourceType);
                        // Each provider has its own credential format
                        // (Sentry tokens are not PostHog tokens; org slugs
                        // are not numeric ids), so clear everything on
                        // switch instead of carrying garbage across.
                        setSourceName("");
                        setAuthToken("");
                        setWazuhBaseUrl("");
                        setIndexPatternsText("");
                        setPosthogCustomBaseUrl("");
                        setPosthogBaseUrlMode("us");
                        setAdvancedOrgInput("");
                        setAdvancedProjectsInput("");
                        setCustomSetupFieldValues({});
                        setDialogError(null);
                      }}
                      aria-pressed={selected}
                      className={`flex flex-col items-center gap-2 rounded-lg border p-3 text-sm transition-colors ${cardClassName}`}
                    >
                      <ProviderIcon
                        kind={card.icon}
                        size={32}
                        className={iconClassName}
                      />
                      <span className="font-medium">{card.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1">
              <FieldLabel required>
                {t("common.errorSourcesManager.labelName")}
              </FieldLabel>
              <Input
                placeholder={t(namePlaceholderKey)}
                value={sourceName}
                onChange={(e) => { setSourceName(e.target.value); }}
              />
            </div>

            {/* Slider — only the credentials and Advanced Options button
             * swap pages. The provider picker and name above always stay
             * visible so the user keeps their visual context.
             */}
            <div data-tour="data-sources-credentials" className="relative overflow-hidden">
              <div
                className={credentialsPageClassName}
                aria-hidden={showAdvanced}
              >
                <div className="space-y-3">
                  {sourceType === "wazuh" && (
                    <>
                      <div className="space-y-1">
                        <FieldLabel required>
                          {baseUrlLabel}
                        </FieldLabel>
                        <Input
                          placeholder={baseUrlPlaceholder}
                          value={wazuhBaseUrl}
                          onChange={(e) => { setWazuhBaseUrl(e.target.value); }}
                        />
                        {baseUrlDescription && (
                          <p className="text-xs text-muted-foreground">
                            {baseUrlDescription}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <FieldLabel required>
                          {authLabel}
                        </FieldLabel>
                        <Input
                          placeholder={authPlaceholder}
                          type="password"
                          value={authToken}
                          onChange={(e) => { setAuthToken(e.target.value); }}
                        />
                        {authDescription && (
                          <p className="text-xs text-muted-foreground">
                            {authDescription}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <FieldLabel>
                          {indexPatternsLabel}
                        </FieldLabel>
                        <Input
                          placeholder={indexPatternsPlaceholder}
                          value={indexPatternsText}
                          onChange={(e) => { setIndexPatternsText(e.target.value); }}
                        />
                        <p className="text-xs text-muted-foreground">
                          {indexPatternsDescription ??
                            t("common.errorSourcesManager.indexPatternsHelp")}
                        </p>
                      </div>
                    </>
                  )}
                  {sourceType !== "wazuh" && (
                    <>
                      {sourceType === "posthog" && (
                        <div className="space-y-1">
                          <FieldLabel required>
                            {baseUrlLabel}
                          </FieldLabel>
                          <div className="grid gap-2 md:grid-cols-[8rem_1fr]">
                            <div className="relative">
                              <select
                                className="h-9 w-full appearance-none rounded-md border bg-background pl-3 pr-8 text-sm"
                                value={posthogBaseUrlMode}
                                onChange={(e) =>
                                  { setPosthogBaseUrlMode(
                                    e.target.value as "us" | "eu" | "custom",
                                  ); }
                                }
                                aria-label={t(
                                  "common.errorSourcesManager.posthogApiBase",
                                )}
                              >
                                <option value="us">
                                  {t("common.errorSourcesManager.regionUs")}
                                </option>
                                <option value="eu">
                                  {t("common.errorSourcesManager.regionEu")}
                                </option>
                                <option value="custom">
                                  {t("common.errorSourcesManager.regionCustom")}
                                </option>
                              </select>
                              <SelectChevron />
                            </div>
                            <Input
                              placeholder={
                                baseUrlSetupField?.placeholder ??
                                t(
                                  "common.errorSourcesManager.posthogApiBaseCustomPlaceholder",
                                )
                              }
                              value={posthogBaseUrlValue}
                              onChange={(e) =>
                                { setPosthogCustomBaseUrl(e.target.value); }
                              }
                              readOnly={posthogBaseUrlMode !== "custom"}
                              disabled={posthogBaseUrlMode !== "custom"}
                            />
                          </div>
                          {baseUrlDescription && (
                            <p className="text-xs text-muted-foreground">
                              {baseUrlDescription}
                            </p>
                          )}
                        </div>
                      )}

                      <div className="space-y-1">
                        <FieldLabel required>
                          {authLabel}
                        </FieldLabel>
                        <Input
                          placeholder={authPlaceholder}
                          type="password"
                          value={authToken}
                          onChange={(e) => { setAuthToken(e.target.value); }}
                        />
                        {authDescription && (
                          <p className="text-xs text-muted-foreground">
                            {authDescription}
                          </p>
                        )}
                      </div>

                      <div className="space-y-1">
                        <FieldLabel required={orgRequired}>
                          {orgLabel}
                        </FieldLabel>
                        <Input
                          placeholder={orgPlaceholder}
                          value={advancedOrgInput}
                          onChange={(e) => { setAdvancedOrgInput(e.target.value); }}
                        />
                        {orgDescription && (
                          <p className="text-xs text-muted-foreground">
                            {orgDescription}
                          </p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <FieldLabel required={projectsRequired}>
                          {projectsLabel}
                        </FieldLabel>
                        <Input
                          placeholder={projectsPlaceholder}
                          value={advancedProjectsInput}
                          onChange={(e) =>
                            { setAdvancedProjectsInput(e.target.value); }
                          }
                          required={projectsRequired}
                        />
                        {projectsDescription && (
                          <p className="text-xs text-muted-foreground">
                            {projectsDescription}
                          </p>
                        )}
                      </div>
                    </>
                  )}
                  {customSetupFields.length > 0 && (
                    <>
                      {customSetupFields.map((field) => {
                        const value = customSetupFieldValues[field.key] ?? "";
                        const placeholder = field.placeholder ?? "";
                        const isPassword = field.control === "password";
                        const isList = field.control === "multiline_list";

                        return (
                          <div key={field.key} className="space-y-1">
                            <FieldLabel required={field.required}>
                              {field.label}
                            </FieldLabel>
                            <Input
                              placeholder={placeholder}
                              type={isPassword ? "password" : "text"}
                              value={value}
                              onChange={(e) => {
                                const nextValue = e.target.value;
                                setCustomSetupFieldValues((current) => ({
                                  ...current,
                                  [field.key]: nextValue,
                                }));
                              }}
                            />
                            <p className="text-xs text-muted-foreground">
                              {field.description ??
                                (isList
                                  ? "Separate multiple values with commas or new lines."
                                  : "")}
                            </p>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => { setShowAdvanced(true); }}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <span>{t("common.errorSourcesManager.advancedOptions")}</span>
                  <svg
                    className="size-3.5"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="1" y1="6" x2="10" y2="6" />
                    <polyline points="6,2 10,6 6,10" />
                  </svg>
                </button>
              </div>

              {/* Page 2 — Advanced options (slides in from the right). */}
              <div
                className={advancedPageClassName}
                aria-hidden={!showAdvanced}
              >
                <button
                  type="button"
                  onClick={() => { setShowAdvanced(false); }}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <svg
                    className="size-3.5"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="6,2 2,6 6,10" />
                    <line x1="2" y1="6" x2="11" y2="6" />
                  </svg>
                  <span>{t("common.errorSourcesManager.advancedOptions")}</span>
                </button>

                <div className="flex items-center justify-between gap-3">
                  <label className="text-sm text-muted-foreground">
                    {t("common.errorSourcesManager.logLevelThreshold")}
                  </label>
                  <div className="relative">
                    <select
                      className="h-10 w-32 appearance-none rounded-md border bg-background pl-3 pr-9 text-sm"
                      value={logLevelThreshold}
                      onChange={(e) =>
                        { setLogLevelThreshold(
                          e.target.value as LogLevelThreshold,
                        ); }
                      }
                    >
                      <option value="error">
                        {t("common.errorSourcesManager.error")}
                      </option>
                      <option value="warning">
                        {t("common.errorSourcesManager.warning")}
                      </option>
                      <option value="info">
                        {t("common.errorSourcesManager.info")}
                      </option>
                      <option value="debug">
                        {t("common.errorSourcesManager.debug")}
                      </option>
                    </select>
                    <SelectChevron />
                  </div>
                </div>

                <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>
                    {t("common.errorSourcesManager.enableScheduledSync")}
                  </span>
                  <input
                    type="checkbox"
                    checked={syncEnabledOnCreate}
                    onChange={(e) => { setSyncEnabledOnCreate(e.target.checked); }}
                  />
                </label>
              </div>
            </div>

            {dialogError && (
              <div
                role="alert"
                className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
              >
                {dialogError}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddDialogOpen(false);
                resetCreateDialog();
              }}
              disabled={actionLoading}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void createSource()}
              disabled={createSourceDisabled}
            >
              {createButtonLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editDialogSource != null}
        onOpenChange={(open) => {
          if (!open) {
            setEditSetupFieldValues({});
            setEditDialogSource(null);
            setEditDialogError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("common.errorSourcesManager.editExternalSource")}
            </DialogTitle>
            <DialogDescription>
              {t("common.errorSourcesManager.editDescription")}
            </DialogDescription>
          </DialogHeader>

          {editDialogSource !== null && (
            <div className="space-y-4">
              <div className="space-y-1">
                <FieldLabel required>
                  {t("common.errorSourcesManager.labelName")}
                </FieldLabel>
                <Input
                  value={editName}
                  onChange={(e) => { setEditName(e.target.value); }}
                  disabled={updateMutation.isPending}
                />
              </div>

              {renderEditConnectionFields({
                source: editDialogSource,
                plugin: editDialogPlugin,
                values: editSetupFieldValues,
                onChange: (fieldKey, nextValue) => {
                  setEditSetupFieldValues((current) => ({
                    ...current,
                    [fieldKey]: nextValue,
                  }));
                },
                t,
                disabled: updateMutation.isPending,
              })}

              <div className="flex items-center justify-between gap-3">
                <label className="text-sm text-muted-foreground">
                  {t("common.errorSourcesManager.logLevelThreshold")}
                </label>
                <div className="relative">
                  <select
                    className="h-10 w-32 appearance-none rounded-md border bg-background pl-3 pr-9 text-sm"
                    value={editLogThreshold}
                    onChange={(e) =>
                      { setEditLogThreshold(e.target.value as LogLevelThreshold); }
                    }
                    disabled={updateMutation.isPending}
                  >
                    <option value="error">
                      {t("common.errorSourcesManager.error_2")}
                    </option>
                    <option value="warning">
                      {t("common.errorSourcesManager.warning_2")}
                    </option>
                    <option value="info">
                      {t("common.errorSourcesManager.info_2")}
                    </option>
                    <option value="debug">
                      {t("common.errorSourcesManager.debug_2")}
                    </option>
                  </select>
                  <SelectChevron />
                </div>
              </div>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  {t("common.errorSourcesManager.enableScheduledSync")}
                </span>
                <input
                  type="checkbox"
                  checked={editSyncEnabled}
                  onChange={(e) => { setEditSyncEnabled(e.target.checked); }}
                  disabled={updateMutation.isPending}
                />
              </label>

              {editDialogErrorContent}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditSetupFieldValues({});
                setEditDialogSource(null);
                setEditDialogError(null);
              }}
              disabled={updateMutation.isPending}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void saveEdit()}
              disabled={updateMutation.isPending}
            >
              {saveEditLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function readStringFromConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): string {
  if (config === undefined) return "";
  const value = config[key];
  if (typeof value === "string") return value;
  return "";
}

function readStringArrayFromConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): string {
  if (config === undefined) return "";
  const value = config[key];
  if (!Array.isArray(value)) return "";
  return value.filter((v): v is string => typeof v === "string").join(", ");
}

function renderEditConnectionFields(input: {
  source: ErrorSourceRow;
  plugin: PluginManifest | null;
  values: Record<string, string>;
  onChange: (fieldKey: string, nextValue: string) => void;
  t: (key: string) => string;
  disabled: boolean;
}): ReactNode {
  const { source, plugin, values, onChange, t, disabled } = input;
  const setupFields = plugin?.metadata?.errorSource?.setupFields ?? [];

  if (setupFields.length === 0) {
    return renderLegacyEditConnectionFields(source, t);
  }

  return (
    <>
      {setupFields.map((field) => {
        const value = values[field.key] ?? "";
        const placeholder =
          field.target === "authToken" || field.storage === "accessTokenRef"
            ? "Leave blank to keep the current token."
            : (field.placeholder ?? "");
        const isPassword = field.control === "password";
        const description =
          field.description ??
          (field.control === "multiline_list"
            ? "Separate multiple values with commas or new lines."
            : "");

        return (
          <div key={field.key} className="space-y-1">
            <FieldLabel required={field.required}>
              {field.label}
            </FieldLabel>
            <Input
              value={value}
              placeholder={placeholder}
              type={isPassword ? "password" : "text"}
              onChange={(event) => { onChange(field.key, event.target.value); }}
              disabled={disabled}
            />
            {description.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
