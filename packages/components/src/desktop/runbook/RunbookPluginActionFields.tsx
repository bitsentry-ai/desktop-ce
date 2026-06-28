import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { PluginActionDefinition, PluginFieldDefinition } from "../../services";
import type { RunbookActionTypeFieldsProps } from "./RunbookActionFieldShared";

type RunbookPluginActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  | "action"
  | "pluginDescriptors"
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
    .map((field) => {
      let label = field.key;
      if (field.required) {
        label = `${label} ${t("runbooks.runbook.required").toLowerCase()}`;
      }
      return label;
    })
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
      if (rawValue === true) {
        return "true";
      }
      return "false";
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

function omitRecordField(
  record: Record<string, unknown>,
  keyToRemove: string,
): Record<string, unknown> {
  const nextRecord: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key !== keyToRemove) {
      nextRecord[key] = value;
    }
  }

  return nextRecord;
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
        return omitRecordField(nextRecord, field.key);
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
        return omitRecordField(nextRecord, field.key);
      }

      const items = readStringArrayInput(nextValue);
      if (items.length === 0) {
        return omitRecordField(nextRecord, field.key);
      }

      nextRecord[field.key] = items;
      return nextRecord;
    }
    case "json": {
      if (typeof nextValue !== "string" || nextValue.trim().length === 0) {
        return omitRecordField(nextRecord, field.key);
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
        return omitRecordField(nextRecord, field.key);
      }

      if (nextValue.length === 0 && !field.required) {
        return omitRecordField(nextRecord, field.key);
      }

      nextRecord[field.key] = nextValue;
      return nextRecord;
    }
  }
}

function readStructuredFieldDescription(
  field: PluginFieldDefinition,
  rawJsonOnlyText: string,
): string {
  if (field.description !== undefined) {
    return field.description;
  }

  if (field.type === "json") {
    return rawJsonOnlyText;
  }

  if (field.type === "string_array") {
    return "Separate multiple values with commas or new lines.";
  }

  return "";
}

function readStructuredTextareaRows(field: PluginFieldDefinition): number {
  if (field.type === "json") {
    return 5;
  }

  return 3;
}

function readStructuredTextareaPlaceholder(
  field: PluginFieldDefinition,
): string {
  if (field.placeholder !== undefined) {
    return field.placeholder;
  }

  if (field.type === "string_array") {
    return "value-a\nvalue-b";
  }

  return "{}";
}

function readStructuredInputType(field: PluginFieldDefinition): string {
  if (field.secret === true) {
    return "password";
  }

  if (field.type === "number") {
    return "number";
  }

  return "text";
}

function readStructuredInputPlaceholder(
  field: PluginFieldDefinition,
): string | undefined {
  if (field.placeholder !== undefined) {
    return field.placeholder;
  }

  if (field.type === "number") {
    return "0";
  }

  return undefined;
}

function renderStructuredFieldInput({
  field,
  fieldValue,
  inputId,
  parsedValue,
  onJsonChange,
}: {
  field: PluginFieldDefinition;
  fieldValue: string;
  inputId: string;
  parsedValue: Record<string, unknown> | null;
  onJsonChange: (nextValue: string | undefined) => void;
}): ReactNode {
  const updateField = (nextValue: string | boolean): void => {
    if (parsedValue === null) {
      return;
    }

    const nextRecord = updateStructuredFieldRecord({
      record: parsedValue,
      field,
      nextValue,
    });
    onJsonChange(serializeJsonObject(nextRecord));
  };

  const disabled = parsedValue === null;

  if (field.type === "boolean") {
    return (
      <select
        id={inputId}
        value={fieldValue}
        disabled={disabled}
        onChange={(event) => {
          updateField(event.target.value === "true");
        }}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
      >
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  }

  if (field.type === "string" && field.enumValues !== undefined) {
    return (
      <select
        id={inputId}
        value={fieldValue}
        disabled={disabled}
        onChange={(event) => {
          updateField(event.target.value);
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
    );
  }

  if (field.type === "string_array" || field.type === "json") {
    return (
      <textarea
        id={inputId}
        value={fieldValue}
        disabled={disabled}
        rows={readStructuredTextareaRows(field)}
        onChange={(event) => {
          updateField(event.target.value);
        }}
        placeholder={readStructuredTextareaPlaceholder(field)}
        className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
      />
    );
  }

  return (
    <input
      id={inputId}
      type={readStructuredInputType(field)}
      value={fieldValue}
      disabled={disabled}
      onChange={(event) => {
        updateField(event.target.value);
      }}
      placeholder={readStructuredInputPlaceholder(field)}
      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
    />
  );
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
        let fieldValue = "";
        if (parsed.value !== null) {
          fieldValue = readStructuredFieldStringValue(parsed.value, field);
        }
        const inputId = `plugin-structured-${label}-${field.key}`;
        const fieldDescription = readStructuredFieldDescription(
          field,
          rawJsonOnlyText,
        );

        return (
          <div key={field.key} className="space-y-1.5">
            <label
              htmlFor={inputId}
              className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60"
            >
              {field.label}
              {field.required && " *"}
            </label>

            {renderStructuredFieldInput({
              field,
              fieldValue,
              inputId,
              parsedValue: parsed.value,
              onJsonChange,
            })}

            <p className="text-[11px] text-muted-foreground/60">
              {fieldDescription}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function readPluginPlaceholderText({
  pluginsLoading,
  pluginOptionsLength,
  t,
}: {
  pluginsLoading: boolean;
  pluginOptionsLength: number;
  t: RunbookPluginActionFieldsProps["t"];
}): string {
  if (pluginsLoading) {
    return t("runbooks.runbook.loadingPlugins");
  }

  if (pluginOptionsLength === 0) {
    return t("runbooks.runbook.noPluginsAvailable");
  }

  return t("runbooks.runbook.selectAPlugin");
}

function readPluginActionPlaceholderText({
  selectedPlugin,
  pluginActionsLength,
  t,
}: {
  selectedPlugin: unknown;
  pluginActionsLength: number;
  t: RunbookPluginActionFieldsProps["t"];
}): string {
  if (selectedPlugin === undefined) {
    return t("runbooks.runbook.selectAPlugin");
  }

  if (pluginActionsLength === 0) {
    return t("runbooks.runbook.noPluginActionsAvailable");
  }

  return t("runbooks.runbook.selectAPluginAction");
}

function resolvePluginActionSelection({
  actions,
  currentActionId,
}: {
  actions: PluginActionDefinition[];
  currentActionId: string | undefined;
}): PluginActionDefinition | null {
  if (currentActionId !== undefined && currentActionId.length > 0) {
    const preservedAction = actions.find(
      (pluginAction) => pluginAction.id === currentActionId,
    );
    if (preservedAction !== undefined) {
      return preservedAction;
    }
  }

  return actions[0] ?? null;
}

function readActionSelectClassName(selectedPlugin: unknown): string {
  if (selectedPlugin === undefined) {
    return "border-border/60 text-muted-foreground/60";
  }

  return "border-border focus:border-primary/50";
}

export function RunbookPluginActionFields({
  action,
  pluginDescriptors,
  pluginOptions,
  pluginsLoading,
  onActionChange,
  t,
}: RunbookPluginActionFieldsProps) {
  const selectedPlugin = pluginDescriptors.find(
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

  const pluginPlaceholderText = readPluginPlaceholderText({
    pluginsLoading,
    pluginOptionsLength: pluginOptions.length,
    t,
  });
  const pluginActionPlaceholderText = readPluginActionPlaceholderText({
    selectedPlugin,
    pluginActionsLength: pluginActions.length,
    t,
  });

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
            const nextPlugin = pluginDescriptors.find((plugin) => plugin.id === pluginId);
            const nextPluginAuthValue = normalizeJsonForFields(
              nextPlugin?.auth.fields ?? [],
              action.pluginAuth,
            );
            const currentActionId = action.pluginActionId?.trim();
            const nextPluginAction = resolvePluginActionSelection({
              actions: nextPlugin?.actions ?? [],
              currentActionId,
            });
            const nextPluginInputValue = normalizeJsonForFields(
              nextPluginAction?.fields ?? [],
              action.pluginInput,
            );
            let nextPluginId: string | undefined;
            let nextPluginActionId: string | undefined;
            let nextPluginInput: string | undefined;
            let nextPluginAuth: string | undefined;

            if (pluginId.length > 0) {
              nextPluginId = pluginId;
              nextPluginActionId = nextPluginAction?.id;
              nextPluginInput = nextPluginInputValue;
              nextPluginAuth = nextPluginAuthValue;
            }

            onActionChange({
              ...action,
              pluginId: nextPluginId,
              pluginActionId: nextPluginActionId,
              pluginInput: nextPluginInput,
              pluginAuth: nextPluginAuth,
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
            let nextPluginActionId: string | undefined;
            let nextPluginInput: string | undefined;
            if (pluginActionId.length > 0) {
              nextPluginActionId = pluginActionId;
              nextPluginInput = nextActionValue;
            }

            onActionChange({
              ...action,
              pluginActionId: nextPluginActionId,
              pluginInput: nextPluginInput,
            });
          }}
          className={cn(
            "w-full rounded-lg border bg-background px-3 py-2 text-xs outline-none transition-colors",
            readActionSelectClassName(selectedPlugin),
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
