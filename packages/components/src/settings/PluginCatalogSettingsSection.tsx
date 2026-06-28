import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, PlugZap } from "lucide-react";

import type {
  PluginActionDefinition,
  PluginFieldDefinition,
  PluginManifest,
} from "../services";
import {
  useClearPluginStoredAuth,
  useExecutePluginAction,
  usePlugins,
  usePluginStoredAuth,
  useUpdatePluginStoredAuth,
} from "../services";
import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Textarea } from "../ui/textarea";

interface PluginCatalogSettingsSectionProps {
  id?: string;
  className?: string;
}

function riskBadgeClassName(riskLevel: PluginActionDefinition["riskLevel"]): string {
  if (riskLevel === "write") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }

  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
}

function stringArrayHint(field: PluginFieldDefinition): string | undefined {
  if (field.type === "string_array") {
    return "Enter one value per line.";
  }
  if (field.type === "json") {
    return "Provide valid JSON.";
  }
  return undefined;
}

function isLongTextField(field: PluginFieldDefinition): boolean {
  if (field.type !== "string") {
    return false;
  }

  return /body|content|description|payload|message/i.test(field.key);
}

function fieldDefaultValueMap(
  fields: PluginFieldDefinition[],
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.defaultValue !== undefined) {
      defaults[field.key] = field.defaultValue;
    }
  }

  return defaults;
}

function fieldDefaultHint(field: PluginFieldDefinition): string | undefined {
  const serialized = serializeFieldValue(field, field.defaultValue);
  if (serialized.trim().length === 0) {
    return undefined;
  }

  if (field.type === "string_array") {
    return `Default values:\n${serialized}`;
  }

  return `Default: ${serialized}`;
}

function fieldEnumHint(field: PluginFieldDefinition): string | undefined {
  if (field.enumValues === undefined || field.enumValues.length === 0) {
    return undefined;
  }

  return `Allowed values: ${field.enumValues.join(", ")}`;
}

function parseFieldValue(field: PluginFieldDefinition, rawValue: string): unknown {
  const normalized = rawValue.trim();

  if (field.type === "boolean") {
    if (normalized.length === 0) {
      if (field.required) {
        throw new Error(`${field.label} is required.`);
      }
      return undefined;
    }

    if (normalized !== "true" && normalized !== "false") {
      throw new Error(`${field.label} must be true or false.`);
    }

    return normalized === "true";
  }

  if (normalized.length === 0) {
    if (field.required) {
      throw new Error(`${field.label} is required.`);
    }
    return undefined;
  }

  if (field.type === "number") {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      throw new Error(`${field.label} must be a number.`);
    }
    return numeric;
  }

  if (field.type === "json") {
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      throw new Error(
        `${field.label} must be valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (field.type === "string_array") {
    return rawValue
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (
    field.enumValues !== undefined &&
    !field.enumValues.includes(rawValue)
  ) {
    throw new Error(
      `${field.label} must be one of: ${field.enumValues.join(", ")}.`,
    );
  }

  return rawValue;
}

function buildPayload(
  fields: PluginFieldDefinition[],
  values: Record<string, string>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of fields) {
    const parsed = parseFieldValue(field, values[field.key] ?? "");
    if (parsed !== undefined) {
      payload[field.key] = parsed;
    }
  }

  return payload;
}

function mergeRawFieldValues(
  fields: PluginFieldDefinition[],
  currentValues: Record<string, string>,
  fallbackValues: Record<string, unknown>,
): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const field of fields) {
    const currentValue = currentValues[field.key];
    if (typeof currentValue === "string" && currentValue.trim().length > 0) {
      merged[field.key] = currentValue;
      continue;
    }

    const fallbackValue = fallbackValues[field.key];
    const serializedFallback = serializeFieldValue(field, fallbackValue);
    if (serializedFallback.trim().length > 0) {
      merged[field.key] = serializedFallback;
    }
  }

  return merged;
}

function serializeFieldValue(
  field: PluginFieldDefinition,
  value: unknown,
): string {
  if (value === undefined) {
    return "";
  }

  if (field.type === "boolean") {
    return typeof value === "boolean" ? String(value) : "";
  }

  if (field.type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  }

  if (field.type === "string_array") {
    if (!Array.isArray(value)) {
      return "";
    }

    return value.filter((item): item is string => typeof item === "string").join("\n");
  }

  if (field.type === "json") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }

  return typeof value === "string" ? value : "";
}

function renderResultData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  return JSON.stringify(data, null, 2);
}

function FieldInput({
  field,
  scope,
  value,
  onChange,
}: {
  field: PluginFieldDefinition;
  scope: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const inputId = `${scope}-${field.key}`;
  const hint = stringArrayHint(field);
  const defaultHint = fieldDefaultHint(field);
  const enumHint = fieldEnumHint(field);

  let input = (
    <Input
      id={inputId}
      type={field.secret === true ? "password" : field.type === "number" ? "number" : "text"}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      placeholder={
        field.placeholder ??
        (field.required ? "Required" : "Optional")
      }
    />
  );

  if (field.type === "boolean") {
    input = (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={inputId}>
          <SelectValue placeholder={field.required ? "Select a value" : "Optional"} />
        </SelectTrigger>
        <SelectContent>
          {!field.required && <SelectItem value="">Unset</SelectItem>}
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  } else if (field.type === "string" && field.enumValues !== undefined) {
    input = (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={inputId}>
          <SelectValue placeholder={field.required ? "Select a value" : "Optional"} />
        </SelectTrigger>
        <SelectContent>
          {!field.required && <SelectItem value="">Unset</SelectItem>}
          {field.enumValues.map((enumValue) => (
            <SelectItem key={enumValue} value={enumValue}>
              {enumValue}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (field.type === "json" || field.type === "string_array" || isLongTextField(field)) {
    input = (
      <Textarea
        id={inputId}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={
          field.placeholder ??
          (field.type === "json"
            ? '{ "key": "value" }'
            : field.type === "string_array"
              ? "one\nvalue\nper line"
              : field.required
                ? "Required"
                : "Optional")
        }
        className="min-h-24"
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={inputId}>{field.label}</Label>
        {field.required && (
          <Badge className="border-primary/20 bg-primary/10 text-primary">Required</Badge>
        )}
        {field.secret === true && (
          <Badge className="border-border bg-muted text-muted-foreground">Secret</Badge>
        )}
      </div>
      {input}
      {field.description !== undefined && field.description.length > 0 && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      {hint !== undefined && <p className="text-xs text-muted-foreground">{hint}</p>}
      {enumHint !== undefined && (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{enumHint}</p>
      )}
      {defaultHint !== undefined && (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{defaultHint}</p>
      )}
    </div>
  );
}

function PluginList({
  plugins,
  selectedPluginId,
  onSelect,
}: {
  plugins: PluginManifest[];
  selectedPluginId: string;
  onSelect: (pluginId: string) => void;
}) {
  return (
    <div className="space-y-3">
      {plugins.map((plugin) => {
        const selected = plugin.id === selectedPluginId;

        return (
          <button
            key={plugin.id}
            type="button"
            onClick={() => {
              onSelect(plugin.id);
            }}
            className={cn(
              "w-full rounded-xl border px-4 py-3 text-left transition-colors",
              selected
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card hover:border-border/80 hover:bg-accent/30",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">{plugin.name}</span>
                  <Badge className="border-border bg-muted text-muted-foreground">
                    v{plugin.version}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>
              </div>
              <PlugZap className="mt-0.5 h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>{plugin.actions.length} actions</span>
              <span>{plugin.triggers.length} triggers</span>
              <span>{plugin.auth.fields.length} auth fields</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function PluginCatalogSettingsSection({
  id = "plugins",
  className,
}: PluginCatalogSettingsSectionProps) {
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [selectedActionId, setSelectedActionId] = useState("");
  const [authValues, setAuthValues] = useState<Record<string, string>>({});
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [storageMessage, setStorageMessage] = useState<string | null>(null);
  const pluginsQuery = usePlugins();
  const storedAuthQuery = usePluginStoredAuth(
    selectedPluginId.trim().length > 0 ? selectedPluginId : undefined,
  );
  const executeActionMutation = useExecutePluginAction();
  const updateStoredAuthMutation = useUpdatePluginStoredAuth();
  const clearStoredAuthMutation = useClearPluginStoredAuth();

  const plugins = pluginsQuery.data ?? [];
  const storedAuthValues = storedAuthQuery.data ?? {};
  const selectedPlugin =
    plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0] ?? null;
  const selectedAction =
    selectedPlugin?.actions.find((action) => action.id === selectedActionId) ??
    selectedPlugin?.actions[0] ??
    null;

  useEffect(() => {
    if (plugins.length === 0) {
      if (selectedPluginId !== "") {
        setSelectedPluginId("");
      }
      return;
    }

    if (selectedPlugin === null) {
      setSelectedPluginId(plugins[0]?.id ?? "");
    }
  }, [plugins, selectedPlugin, selectedPluginId]);

  useEffect(() => {
    if (selectedPlugin === null) {
      if (selectedActionId !== "") {
        setSelectedActionId("");
      }
      return;
    }

    if (selectedAction === null) {
      setSelectedActionId(selectedPlugin.actions[0]?.id ?? "");
    }
  }, [selectedAction, selectedActionId, selectedPlugin]);

  useEffect(() => {
    if (selectedPlugin === null) {
      return;
    }

    const defaultValues = fieldDefaultValueMap(selectedPlugin.auth.fields);
    setAuthValues(() => {
      return mergeRawFieldValues(selectedPlugin.auth.fields, {}, {
        ...defaultValues,
        ...storedAuthValues,
      });
    });
  }, [selectedPlugin, storedAuthValues]);

  useEffect(() => {
    const defaultValues =
      selectedAction === null ? {} : fieldDefaultValueMap(selectedAction.fields);
    setInputValues(() =>
      selectedAction === null
        ? {}
        : mergeRawFieldValues(selectedAction.fields, {}, defaultValues),
    );
    setValidationError(null);
    setStorageMessage(null);
    executeActionMutation.reset();
  }, [executeActionMutation, selectedAction, selectedActionId, selectedPluginId]);

  async function handleSaveAuth(): Promise<void> {
    if (selectedPlugin === null) {
      return;
    }

    setStorageMessage(null);

    try {
      const normalized = buildPayload(selectedPlugin.auth.fields, authValues);
      await updateStoredAuthMutation.mutateAsync({
        pluginId: selectedPlugin.id,
        auth: normalized,
      });
      setStorageMessage(
        Object.keys(normalized).length > 0
          ? "Saved plugin authentication for reuse in the desktop runtime."
          : "Cleared saved plugin authentication.",
      );
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClearAuth(): Promise<void> {
    if (selectedPlugin === null) {
      return;
    }

    setStorageMessage(null);

    try {
      await clearStoredAuthMutation.mutateAsync(selectedPlugin.id);
      setAuthValues(() =>
        mergeRawFieldValues(
          selectedPlugin.auth.fields,
          {},
          fieldDefaultValueMap(selectedPlugin.auth.fields),
        ),
      );
      setStorageMessage("Cleared saved plugin authentication.");
    } catch (error) {
      setStorageMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleExecute(): Promise<void> {
    if (selectedPlugin === null || selectedAction === null) {
      return;
    }

    setValidationError(null);

    try {
      const authDefaults = fieldDefaultValueMap(selectedPlugin.auth.fields);
      const inputDefaults = fieldDefaultValueMap(selectedAction.fields);
      const auth = buildPayload(
        selectedPlugin.auth.fields,
        mergeRawFieldValues(selectedPlugin.auth.fields, authValues, {
          ...authDefaults,
          ...storedAuthValues,
        }),
      );
      const input = buildPayload(
        selectedAction.fields,
        mergeRawFieldValues(selectedAction.fields, inputValues, inputDefaults),
      );

      await executeActionMutation.mutateAsync({
        pluginId: selectedPlugin.id,
        actionId: selectedAction.id,
        auth,
        input,
      });
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section id={id} className={cn("scroll-mt-24", className)}>
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-foreground">Plugins</h2>
        <p className="text-xs text-muted-foreground">
          Explore manifest-driven desktop plugins, inspect their declared auth and action
          schemas, and execute GitHub pack actions through a safer typed surface.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
        <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-background/70 p-4">
              <h3 className="text-sm font-semibold text-foreground">Catalog</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                This first slice ports the StackStorm GitHub pack into a TypeScript-native
                desktop runtime.
              </p>
            </div>

            {pluginsQuery.isLoading && (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading plugins...
              </div>
            )}

            {pluginsQuery.isError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Plugin catalog unavailable</AlertTitle>
                <AlertDescription>
                  {pluginsQuery.error instanceof Error
                    ? pluginsQuery.error.message
                    : "Failed to load desktop plugins."}
                </AlertDescription>
              </Alert>
            )}

            {!pluginsQuery.isLoading && !pluginsQuery.isError && plugins.length === 0 && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>No plugins registered</AlertTitle>
                <AlertDescription>
                  The desktop runtime is up, but no plugins have been registered yet.
                </AlertDescription>
              </Alert>
            )}

            {plugins.length > 0 && (
              <PluginList
                plugins={plugins}
                selectedPluginId={selectedPlugin?.id ?? ""}
                onSelect={(pluginId) => {
                  setSelectedPluginId(pluginId);
                }}
              />
            )}
          </div>

          <div className="space-y-5">
            {selectedPlugin !== null && (
              <>
                <div className="rounded-xl border border-border bg-background/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-semibold text-foreground">
                          {selectedPlugin.name}
                        </h3>
                        <Badge className="border-border bg-muted text-muted-foreground">
                          {selectedPlugin.id}
                        </Badge>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {selectedPlugin.description}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge className="border-border bg-muted text-muted-foreground">
                        {selectedPlugin.actions.length} actions
                      </Badge>
                      <Badge className="border-border bg-muted text-muted-foreground">
                        {selectedPlugin.triggers.length} triggers
                      </Badge>
                    </div>
                  </div>

                  {selectedPlugin.referenceRepositoryPath !== undefined && (
                    <div className="mt-4 rounded-lg border border-border bg-card px-3 py-2">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Reference repository
                      </div>
                      <code className="mt-1 block text-xs text-foreground">
                        {selectedPlugin.referenceRepositoryPath}
                      </code>
                    </div>
                  )}
                </div>

                <div className="grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
                  <div className="space-y-5">
                    <div className="rounded-xl border border-border bg-background/70 p-4">
                      <div className="mb-4">
                        <h3 className="text-sm font-semibold text-foreground">
                          Plugin authentication
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Saved values are reused by plugin execution in the desktop runtime,
                          including runbooks and plugin-backed integrations when a step omits
                          explicit auth.
                        </p>
                      </div>
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2">
                        <div className="text-xs text-muted-foreground">
                          {storedAuthQuery.isLoading
                            ? "Loading saved plugin auth..."
                            : Object.keys(storedAuthValues).length > 0
                              ? "Saved auth is available for this plugin."
                              : "No saved auth for this plugin yet."}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              void handleClearAuth();
                            }}
                            disabled={
                              selectedPlugin.auth.fields.length === 0 ||
                              clearStoredAuthMutation.isPending
                            }
                          >
                            {clearStoredAuthMutation.isPending ? "Clearing..." : "Clear saved auth"}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              void handleSaveAuth();
                            }}
                            disabled={
                              selectedPlugin.auth.fields.length === 0 ||
                              updateStoredAuthMutation.isPending
                            }
                          >
                            {updateStoredAuthMutation.isPending ? "Saving..." : "Save auth"}
                          </Button>
                        </div>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        {selectedPlugin.auth.fields.map((field) => (
                          <FieldInput
                            key={field.key}
                            field={field}
                            scope={`${selectedPlugin.id}-auth`}
                            value={authValues[field.key] ?? ""}
                            onChange={(next) => {
                              setAuthValues((current) => ({
                                ...current,
                                [field.key]: next,
                              }));
                            }}
                          />
                        ))}
                      </div>
                      {storageMessage !== null && (
                        <p className="mt-3 text-xs text-muted-foreground">{storageMessage}</p>
                      )}
                    </div>

                    {selectedAction !== null && (
                      <div className="rounded-xl border border-border bg-background/70 p-4">
                        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                          <div className="min-w-0">
                            <h3 className="text-sm font-semibold text-foreground">
                              Action execution
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Every form field is generated from the plugin manifest instead of
                              bespoke UI code.
                            </p>
                          </div>
                          <div className="w-full max-w-sm">
                            <Label htmlFor={`${selectedPlugin.id}-action-select`}>
                              Selected action
                            </Label>
                            <Select
                              value={selectedAction.id}
                              onValueChange={(next) => {
                                setSelectedActionId(next);
                              }}
                            >
                              <SelectTrigger id={`${selectedPlugin.id}-action-select`}>
                                <SelectValue placeholder="Choose an action" />
                              </SelectTrigger>
                              <SelectContent>
                                {selectedPlugin.actions.map((action) => (
                                  <SelectItem key={action.id} value={action.id}>
                                    {action.title}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="rounded-xl border border-border bg-card p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-foreground">
                                  {selectedAction.title}
                                </span>
                                <Badge className={riskBadgeClassName(selectedAction.riskLevel)}>
                                  {selectedAction.riskLevel}
                                </Badge>
                              </div>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {selectedAction.description}
                              </p>
                            </div>
                            <Badge className="border-border bg-muted text-muted-foreground">
                              {selectedAction.id}
                            </Badge>
                          </div>

                          {selectedAction.referencePath !== undefined && (
                            <div className="mt-4 rounded-lg border border-border bg-background px-3 py-2">
                              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Reference action
                              </div>
                              <code className="mt-1 block text-xs text-foreground">
                                {selectedAction.referencePath}
                              </code>
                            </div>
                          )}

                          <div className="mt-4 grid gap-4 md:grid-cols-2">
                            {selectedAction.fields.map((field) => (
                              <FieldInput
                                key={field.key}
                                field={field}
                                scope={`${selectedPlugin.id}-${selectedAction.id}`}
                                value={inputValues[field.key] ?? ""}
                                onChange={(next) => {
                                  setInputValues((current) => ({
                                    ...current,
                                    [field.key]: next,
                                  }));
                                }}
                              />
                            ))}
                          </div>

                          <div className="mt-5 flex items-center justify-between gap-3">
                            <p className="text-xs text-muted-foreground">
                              Write actions are intentionally labeled so agent-facing surfaces
                              can apply stronger guardrails later.
                            </p>
                            <Button
                              type="button"
                              onClick={() => {
                                void handleExecute();
                              }}
                              disabled={executeActionMutation.isPending}
                            >
                              {executeActionMutation.isPending ? (
                                <>
                                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                  Executing...
                                </>
                              ) : (
                                "Execute action"
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}

                    {validationError !== null && (
                      <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Execution blocked</AlertTitle>
                        <AlertDescription>{validationError}</AlertDescription>
                      </Alert>
                    )}

                    {executeActionMutation.data !== undefined && (
                      <Alert
                        variant={executeActionMutation.data.ok ? "default" : "destructive"}
                      >
                        {executeActionMutation.data.ok ? (
                          <CheckCircle2 className="h-4 w-4" />
                        ) : (
                          <AlertCircle className="h-4 w-4" />
                        )}
                        <AlertTitle>
                          {executeActionMutation.data.actionId} returned status{" "}
                          {executeActionMutation.data.status}
                        </AlertTitle>
                        <AlertDescription>
                          {executeActionMutation.data.summary}
                        </AlertDescription>
                      </Alert>
                    )}

                    {executeActionMutation.data?.data !== undefined && (
                      <div className="rounded-xl border border-border bg-background/70 p-4">
                        <h3 className="text-sm font-semibold text-foreground">Execution output</h3>
                        <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-border bg-card p-3 text-xs text-foreground">
                          {renderResultData(executeActionMutation.data.data)}
                        </pre>
                      </div>
                    )}
                  </div>

                  <div className="space-y-5">
                    <div className="rounded-xl border border-border bg-background/70 p-4">
                      <h3 className="text-sm font-semibold text-foreground">Declared triggers</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Triggers are manifest metadata today. Webhook and poll execution will
                        sit on top of these definitions in later passes.
                      </p>
                      <div className="mt-4 space-y-3">
                        {selectedPlugin.triggers.map((trigger) => (
                          <div
                            key={trigger.id}
                            className="rounded-xl border border-border bg-card p-3"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-foreground">
                                {trigger.title}
                              </span>
                              <Badge className="border-border bg-muted text-muted-foreground">
                                {trigger.kind}
                              </Badge>
                              <Badge className="border-border bg-muted text-muted-foreground">
                                {trigger.id}
                              </Badge>
                            </div>
                            <p className="mt-2 text-xs text-muted-foreground">
                              {trigger.description}
                            </p>
                            {trigger.eventTypes.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {trigger.eventTypes.map((eventType) => (
                                  <Badge
                                    key={eventType}
                                    className="border-border bg-background text-muted-foreground"
                                  >
                                    {eventType}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-background/70 p-4">
                      <h3 className="text-sm font-semibold text-foreground">Safety notes</h3>
                      <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                        <li>
                          Actions can only accept fields that the plugin manifest explicitly
                          declares.
                        </li>
                        <li>
                          Secret auth fields are modeled separately from action input fields so
                          agent surfaces can redact them.
                        </li>
                        <li>
                          The current GitHub slice ports StackStorm reference actions into
                          TypeScript without embedding arbitrary Python execution.
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
