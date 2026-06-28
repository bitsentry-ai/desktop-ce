import { cn } from "../../lib/utils";
import type { PluginFieldDefinition } from "../../services";
import type { RunbookActionTypeFieldsProps } from "./RunbookActionFieldShared";

type RunbookPluginActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  | "action"
  | "pluginManifests"
  | "pluginOptions"
  | "pluginsLoading"
  | "onActionChange"
  | "t"
>;

function describePluginFields(
  fields: PluginFieldDefinition[],
  t: RunbookPluginActionFieldsProps["t"],
): string {
  if (fields.length === 0) {
    return t("runbooks.runbook.noPluginFieldsDeclared");
  }

  return fields
    .map((field) =>
      `${field.key}${field.required ? ` ${t("runbooks.runbook.required").toLowerCase()}` : ""}`,
    )
    .join(", ");
}

function buildFieldTemplateValue(field: PluginFieldDefinition): unknown {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }

  if (!field.required) {
    return undefined;
  }

  switch (field.type) {
    case "number":
      return 0;
    case "boolean":
      return false;
    case "json":
      return {};
    case "string_array":
      return [];
    case "string":
    default:
      return "";
  }
}

function buildFieldTemplateJson(fields: PluginFieldDefinition[]): string | undefined {
  const template: Record<string, unknown> = {};

  for (const field of fields) {
    const value = buildFieldTemplateValue(field);
    if (value !== undefined) {
      template[field.key] = value;
    }
  }

  if (Object.keys(template).length === 0) {
    return undefined;
  }

  return JSON.stringify(template, null, 2);
}

function parseJsonObject(
  raw: string | undefined,
): { value: Record<string, unknown> | null; error: boolean } {
  if (raw === undefined || raw.trim().length === 0) {
    return { value: {}, error: false };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: null, error: true };
    }

    return { value: parsed as Record<string, unknown>, error: false };
  } catch {
    return { value: null, error: true };
  }
}

function serializeJsonObject(value: Record<string, unknown>): string | undefined {
  if (Object.keys(value).length === 0) {
    return undefined;
  }

  return JSON.stringify(value, null, 2);
}

function normalizeJsonForFields(
  fields: PluginFieldDefinition[],
  rawJson: string | undefined,
): string | undefined {
  const parsed = parseJsonObject(rawJson);
  const nextValue: Record<string, unknown> = {};

  for (const field of fields) {
    if (parsed.value !== null && field.key in parsed.value) {
      nextValue[field.key] = parsed.value[field.key];
      continue;
    }

    if (field.defaultValue !== undefined) {
      nextValue[field.key] = field.defaultValue;
    }
  }

  return serializeJsonObject(nextValue);
}

function readStringArrayInput(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readStructuredFieldStringValue(
  record: Record<string, unknown>,
  field: PluginFieldDefinition,
): string {
  const rawValue = record[field.key];

  switch (field.type) {
    case "number":
      if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
        return String(rawValue);
      }
      return "";
    case "boolean":
      return rawValue === true ? "true" : "false";
    case "string_array":
      if (!Array.isArray(rawValue)) {
        return "";
      }

      return rawValue
        .filter((item): item is string => typeof item === "string")
        .join("\n");
    case "json":
      if (rawValue === undefined) {
        return "";
      }

      return JSON.stringify(rawValue, null, 2);
    case "string":
    default:
      if (typeof rawValue === "string") {
        return rawValue;
      }
      return "";
  }
}

function updateStructuredFieldRecord(input: {
  record: Record<string, unknown>;
  field: PluginFieldDefinition;
  nextValue: string | boolean;
}): Record<string, unknown> {
  const nextRecord = { ...input.record };
  const { field, nextValue } = input;

  switch (field.type) {
    case "boolean": {
      nextRecord[field.key] = nextValue;
      return nextRecord;
    }
    case "number": {
      if (typeof nextValue !== "string" || nextValue.trim().length === 0) {
        delete nextRecord[field.key];
        return nextRecord;
      }

      const numeric = Number(nextValue);
      if (!Number.isFinite(numeric)) {
        return nextRecord;
      }

      nextRecord[field.key] = numeric;
      return nextRecord;
    }
    case "string_array": {
      if (typeof nextValue !== "string") {
        delete nextRecord[field.key];
        return nextRecord;
      }

      const items = readStringArrayInput(nextValue);
      if (items.length === 0) {
        delete nextRecord[field.key];
        return nextRecord;
      }

      nextRecord[field.key] = items;
      return nextRecord;
    }
    case "json": {
      if (typeof nextValue !== "string" || nextValue.trim().length === 0) {
        delete nextRecord[field.key];
        return nextRecord;
      }

      try {
        nextRecord[field.key] = JSON.parse(nextValue) as unknown;
      } catch {
        return nextRecord;
      }

      return nextRecord;
    }
    case "string":
    default: {
      if (typeof nextValue !== "string") {
        delete nextRecord[field.key];
        return nextRecord;
      }

      if (nextValue.length === 0 && !field.required) {
        delete nextRecord[field.key];
        return nextRecord;
      }

      nextRecord[field.key] = nextValue;
      return nextRecord;
    }
  }
}

type PluginStructuredFieldsEditorProps = {
  fields: PluginFieldDefinition[];
  jsonValue: string | undefined;
  label: string;
  helpText: string;
  invalidJsonText: string;
  rawJsonOnlyText: string;
  onJsonChange: (nextValue: string | undefined) => void;
};

function PluginStructuredFieldsEditor({
  fields,
  jsonValue,
  label,
  helpText,
  invalidJsonText,
  rawJsonOnlyText,
  onJsonChange,
}: PluginStructuredFieldsEditorProps) {
  if (fields.length === 0) {
    return null;
  }

  const parsed = parseJsonObject(jsonValue);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 px-3 py-3">
      <div>
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {label}
        </p>
        <p className="mt-1 text-[11px] text-muted-foreground/70">{helpText}</p>
      </div>

      {parsed.error && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {invalidJsonText}
        </div>
      )}

      {fields.map((field) => {
        const fieldValue =
          parsed.value === null
            ? ""
            : readStructuredFieldStringValue(parsed.value, field);
        const inputId = `plugin-structured-${label}-${field.key}`;
        const isRawJsonOnlyField = field.type === "json";

        return (
          <div key={field.key} className="space-y-1.5">
            <label
              htmlFor={inputId}
              className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60"
            >
              {field.label}
              {field.required ? " *" : ""}
            </label>

            {field.type === "boolean" ? (
              <select
                id={inputId}
                value={fieldValue}
                disabled={parsed.value === null}
                onChange={(event) => {
                  if (parsed.value === null) return;

                  const nextRecord = updateStructuredFieldRecord({
                    record: parsed.value,
                    field,
                    nextValue: event.target.value === "true",
                  });
                  onJsonChange(serializeJsonObject(nextRecord));
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
              >
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            ) : field.type === "string" && field.enumValues !== undefined ? (
              <select
                id={inputId}
                value={fieldValue}
                disabled={parsed.value === null}
                onChange={(event) => {
                  if (parsed.value === null) return;

                  const nextRecord = updateStructuredFieldRecord({
                    record: parsed.value,
                    field,
                    nextValue: event.target.value,
                  });
                  onJsonChange(serializeJsonObject(nextRecord));
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
              >
                {!field.required && <option value="">Use plugin default</option>}
                {field.enumValues.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : field.type === "string_array" || field.type === "json" ? (
              <textarea
                id={inputId}
                value={fieldValue}
                disabled={parsed.value === null}
                rows={field.type === "json" ? 5 : 3}
                onChange={(event) => {
                  if (parsed.value === null) return;

                  const nextRecord = updateStructuredFieldRecord({
                    record: parsed.value,
                    field,
                    nextValue: event.target.value,
                  });
                  onJsonChange(serializeJsonObject(nextRecord));
                }}
                placeholder={
                  field.placeholder ??
                  (field.type === "string_array" ? "value-a\nvalue-b" : "{}")
                }
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
              />
            ) : (
              <input
                id={inputId}
                type={
                  field.secret ? "password" : field.type === "number" ? "number" : "text"
                }
                value={fieldValue}
                disabled={parsed.value === null}
                onChange={(event) => {
                  if (parsed.value === null) return;

                  const nextRecord = updateStructuredFieldRecord({
                    record: parsed.value,
                    field,
                    nextValue: event.target.value,
                  });
                  onJsonChange(serializeJsonObject(nextRecord));
                }}
                placeholder={
                  field.placeholder ??
                  (field.type === "number" ? "0" : undefined)
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
              />
            )}

            <p className="text-[11px] text-muted-foreground/60">
              {field.description ??
                (isRawJsonOnlyField
                  ? rawJsonOnlyText
                  : field.type === "string_array"
                    ? "Separate multiple values with commas or new lines."
                    : "")}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export function RunbookPluginActionFields({
  action,
  pluginManifests,
  pluginOptions,
  pluginsLoading,
  onActionChange,
  t,
}: RunbookPluginActionFieldsProps) {
  const selectedPlugin = pluginManifests.find(
    (plugin) => plugin.id === action.pluginId,
  );
  const pluginActions = selectedPlugin?.actions ?? [];
  const selectedAction = pluginActions.find(
    (pluginAction) => pluginAction.id === action.pluginActionId,
  );
  const pluginAuthTemplate = buildFieldTemplateJson(
    selectedPlugin?.auth.fields ?? [],
  );
  const pluginInputTemplate = buildFieldTemplateJson(selectedAction?.fields ?? []);

  const pluginPlaceholderText = pluginsLoading
    ? t("runbooks.runbook.loadingPlugins")
    : pluginOptions.length === 0
      ? t("runbooks.runbook.noPluginsAvailable")
      : t("runbooks.runbook.selectAPlugin");
  const pluginActionPlaceholderText =
    selectedPlugin === undefined
      ? t("runbooks.runbook.selectAPlugin")
      : pluginActions.length === 0
        ? t("runbooks.runbook.noPluginActionsAvailable")
        : t("runbooks.runbook.selectAPluginAction");

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.plugin")}
        </label>
        <select
          value={action.pluginId ?? ""}
          disabled={pluginsLoading || pluginOptions.length === 0}
          onChange={(event) => {
            const pluginId = event.target.value.trim();
            const nextPlugin = pluginManifests.find((plugin) => plugin.id === pluginId);
            const nextPluginAuthValue = normalizeJsonForFields(
              nextPlugin?.auth.fields ?? [],
              action.pluginAuth,
            );
            const currentActionId = action.pluginActionId?.trim();
            const preservesAction =
              currentActionId !== undefined &&
              currentActionId.length > 0 &&
              nextPlugin?.actions.some(
                (pluginAction) => pluginAction.id === currentActionId,
              ) === true;
            const nextPluginAction = preservesAction
              ? nextPlugin?.actions.find(
                  (pluginAction) => pluginAction.id === currentActionId,
                ) ?? null
              : nextPlugin?.actions[0] ?? null;
            const nextPluginInputValue = normalizeJsonForFields(
              nextPluginAction?.fields ?? [],
              action.pluginInput,
            );

            onActionChange({
              ...action,
              pluginId: pluginId.length > 0 ? pluginId : undefined,
              pluginActionId:
                pluginId.length > 0 ? nextPluginAction?.id : undefined,
              pluginInput: pluginId.length > 0 ? nextPluginInputValue : undefined,
              pluginAuth: pluginId.length > 0 ? nextPluginAuthValue : undefined,
            });
          }}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
        >
          <option value="" disabled>
            {pluginPlaceholderText}
          </option>
          {pluginOptions.map((plugin) => (
            <option key={plugin.id} value={plugin.id}>
              {plugin.label}
            </option>
          ))}
        </select>
        {selectedPlugin !== undefined && (
          <p className="mt-1.5 text-[11px] text-muted-foreground/60">
            {selectedPlugin.description}
          </p>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.pluginAction")}
        </label>
        <select
          value={action.pluginActionId ?? ""}
          disabled={selectedPlugin === undefined || pluginActions.length === 0}
          onChange={(event) => {
            const pluginActionId = event.target.value.trim();
            const nextActionValue = normalizeJsonForFields(
              pluginActions.find(
                (pluginAction) => pluginAction.id === pluginActionId,
              )?.fields ?? [],
              action.pluginInput,
            );
            onActionChange({
              ...action,
              pluginActionId:
                pluginActionId.length > 0 ? pluginActionId : undefined,
              pluginInput:
                pluginActionId.length > 0 ? nextActionValue : undefined,
            });
          }}
          className={cn(
            "w-full rounded-lg border bg-background px-3 py-2 text-xs outline-none transition-colors",
            selectedPlugin === undefined
              ? "border-border/60 text-muted-foreground/60"
              : "border-border focus:border-primary/50",
          )}
        >
          <option value="" disabled>
            {pluginActionPlaceholderText}
          </option>
          {pluginActions.map((pluginAction) => (
            <option key={pluginAction.id} value={pluginAction.id}>
              {pluginAction.title}
            </option>
          ))}
        </select>
        {selectedAction !== undefined && (
          <div className="mt-1.5 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground/80">
            <p>{selectedAction.description}</p>
            <p className="mt-1">
              {t("runbooks.runbook.pluginRiskLevel")}:{" "}
              <span className="font-medium uppercase">
                {selectedAction.riskLevel}
              </span>
            </p>
            <p className="mt-1">
              {t("runbooks.runbook.pluginInputFields")}:{" "}
              {describePluginFields(selectedAction.fields, t)}
            </p>
          </div>
        )}
      </div>

      <div>
        <PluginStructuredFieldsEditor
          fields={selectedPlugin?.auth.fields ?? []}
          jsonValue={action.pluginAuth}
          label={t("runbooks.runbook.pluginAuthFields")}
          helpText={t("runbooks.runbook.pluginStructuredFieldsHelp")}
          invalidJsonText={t("runbooks.runbook.pluginStructuredFieldsInvalidJson")}
          rawJsonOnlyText={t("runbooks.runbook.pluginStructuredFieldsRawJsonOnly")}
          onJsonChange={(nextValue) => {
            onActionChange({
              ...action,
              pluginAuth: nextValue,
            });
          }}
        />
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("runbooks.runbook.pluginAuthJson")}
          </label>
          {selectedPlugin !== undefined && selectedPlugin.auth.fields.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onActionChange({
                  ...action,
                  pluginAuth: pluginAuthTemplate,
                });
              }}
              className="rounded-md border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/40"
            >
              Fill template
            </button>
          )}
        </div>
        <textarea
          value={action.pluginAuth ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              pluginAuth: event.target.value,
            });
          }}
          rows={4}
          placeholder={t("runbooks.runbook.pluginAuthJsonPlaceholder")}
          className="w-full resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground/60">
          {t("runbooks.runbook.pluginAuthJsonHelp")}{" "}
          {selectedPlugin !== undefined && (
            <>
              {t("runbooks.runbook.pluginAuthFields")}:{" "}
              {describePluginFields(selectedPlugin.auth.fields, t)}
            </>
          )}
        </p>
        {selectedPlugin !== undefined && selectedPlugin.auth.fields.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground/60">
            Saved plugin auth from settings is still merged at execution time when this JSON omits
            fields.
          </p>
        )}
      </div>

      <div>
        <PluginStructuredFieldsEditor
          fields={selectedAction?.fields ?? []}
          jsonValue={action.pluginInput}
          label={t("runbooks.runbook.pluginInputFields")}
          helpText={t("runbooks.runbook.pluginStructuredFieldsHelp")}
          invalidJsonText={t("runbooks.runbook.pluginStructuredFieldsInvalidJson")}
          rawJsonOnlyText={t("runbooks.runbook.pluginStructuredFieldsRawJsonOnly")}
          onJsonChange={(nextValue) => {
            onActionChange({
              ...action,
              pluginInput: nextValue,
            });
          }}
        />
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("runbooks.runbook.pluginInputJson")}
          </label>
          {selectedAction !== undefined && selectedAction.fields.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onActionChange({
                  ...action,
                  pluginInput: pluginInputTemplate,
                });
              }}
              className="rounded-md border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/40"
            >
              Fill template
            </button>
          )}
        </div>
        <textarea
          value={action.pluginInput ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              pluginInput: event.target.value,
            });
          }}
          rows={6}
          placeholder={t("runbooks.runbook.pluginInputJsonPlaceholder")}
          className="w-full resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
        />
        <p className="mt-1.5 text-[11px] text-muted-foreground/60">
          {t("runbooks.runbook.pluginInputJsonHelp")}
        </p>
      </div>
    </div>
  );
}
