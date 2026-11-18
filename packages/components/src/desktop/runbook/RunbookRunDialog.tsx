import { cn } from "../../lib/utils";
import type {
  RuntimeParameterDefinition,
  TranslationFn,
} from "./types";

type RuntimeParameterFieldState = {
  inputType: "password" | "text";
  autoComplete: "new-password" | "off";
  placeholder: string;
  inputBorderClass: string;
  missing: boolean;
  shortSecureValue: boolean;
  visibilityLabel: string;
};

function runtimeParameterMissing(
  parameter: RuntimeParameterDefinition,
  value: string,
): boolean {
  const defaultValue = parameter.defaultValue ?? "";
  return (
    parameter.required &&
    defaultValue.length === 0 &&
    value.trim().length === 0
  );
}

function runtimeParameterShortSecureValue(
  parameter: RuntimeParameterDefinition,
  value: string,
): boolean {
  return parameter.secure && value.length > 0 && value.length < 4;
}

function runtimeParameterInputType(
  parameter: RuntimeParameterDefinition,
  visible: boolean,
): "password" | "text" {
  if (parameter.secure && !visible) {
    return "password";
  }

  return "text";
}

function runtimeParameterAutoComplete(
  parameter: RuntimeParameterDefinition,
): "new-password" | "off" {
  if (parameter.secure) {
    return "new-password";
  }

  return "off";
}

function runtimeParameterPlaceholder(
  parameter: RuntimeParameterDefinition,
  t: TranslationFn,
): string {
  const defaultValue = parameter.defaultValue ?? "";
  let placeholder = t("runbooks.runbook.enterValue");
  if (parameter.secure) {
    placeholder = t("runbooks.runbook.enterSecureValue");
  } else if (defaultValue.length > 0) {
    placeholder = t("runbooks.runbook.defaultParameterValue", {
      value: defaultValue,
    });
  }

  return placeholder;
}

function runtimeParameterBorderClass(
  parameter: RuntimeParameterDefinition,
  value: string,
): string {
  if (runtimeParameterMissing(parameter, value)) {
    return "border-destructive/50";
  }

  return "border-border";
}

function runtimeParameterVisibilityLabel(
  visible: boolean,
  t: TranslationFn,
): string {
  if (visible) {
    return t("runbooks.runbook.hide");
  }

  return t("runbooks.runbook.show");
}

function getRuntimeParameterFieldState(
  parameter: RuntimeParameterDefinition,
  value: string,
  visible: boolean,
  t: TranslationFn,
): RuntimeParameterFieldState {
  return {
    inputType: runtimeParameterInputType(parameter, visible),
    autoComplete: runtimeParameterAutoComplete(parameter),
    placeholder: runtimeParameterPlaceholder(parameter, t),
    inputBorderClass: runtimeParameterBorderClass(parameter, value),
    missing: runtimeParameterMissing(parameter, value),
    shortSecureValue: runtimeParameterShortSecureValue(parameter, value),
    visibilityLabel: runtimeParameterVisibilityLabel(visible, t),
  };
}

function RequiredMarker({ show }: { show: boolean }) {
  if (!show) {
    return null;
  }

  return <span className="ml-1 text-destructive">*</span>;
}

function SecureParameterBadge({ show, t }: { show: boolean; t: TranslationFn }) {
  if (!show) {
    return null;
  }

  return (
    <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
      {t("runbooks.runbook.secure")}
    </span>
  );
}

function RuntimeParameterDescription({ description }: { description: string }) {
  if (description.length === 0) {
    return null;
  }

  return <p className="text-xs text-muted-foreground/70">{description}</p>;
}

function RuntimeParameterVisibilityButton({
  show,
  label,
  onClick,
}: {
  show: boolean;
  label: string;
  onClick: () => void;
}) {
  if (!show) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-border px-2 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {label}
    </button>
  );
}

function RuntimeParameterValidationMessages({
  missing,
  shortSecureValue,
  t,
}: {
  missing: boolean;
  shortSecureValue: boolean;
  t: TranslationFn;
}) {
  return (
    <>
      {missing && (
        <p className="text-xs text-destructive">
          {t("runbooks.runbook.thisValueIsRequired")}
        </p>
      )}
      {shortSecureValue && (
        <p className="text-xs text-amber-600">
          {t("runbooks.runbook.shortSecureValuesCanRedact")}
        </p>
      )}
    </>
  );
}

function RuntimeParameterInputRow({
  parameter,
  value,
  visible,
  onValueChange,
  onToggleVisibility,
  t,
}: {
  parameter: RuntimeParameterDefinition;
  value: string;
  visible: boolean;
  onValueChange: (key: string, value: string) => void;
  onToggleVisibility: (key: string) => void;
  t: TranslationFn;
}) {
  const field = getRuntimeParameterFieldState(parameter, value, visible, t);
  const actionTitles = [...new Set(parameter.actionTitles)];
  const description = parameter.description ?? "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium">
          {parameter.label ?? parameter.key}
          <RequiredMarker show={parameter.required} />
        </label>
        <SecureParameterBadge show={parameter.secure} t={t} />
      </div>
      <div className="flex gap-2">
        <input
          type={field.inputType}
          value={value}
          onChange={(event) => {
            onValueChange(parameter.key, event.target.value);
          }}
          autoComplete={field.autoComplete}
          placeholder={field.placeholder}
          className={cn(
            "min-w-0 flex-1 rounded-md border bg-muted/30 px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50",
            field.inputBorderClass,
          )}
        />
        <RuntimeParameterVisibilityButton
          show={parameter.secure}
          label={field.visibilityLabel}
          onClick={() => {
            onToggleVisibility(parameter.key);
          }}
        />
      </div>
      <RuntimeParameterDescription description={description} />
      <p className="text-xs text-muted-foreground/50">
        {t("runbooks.runbook.usedBy")} {actionTitles.join(", ")}
      </p>
      <RuntimeParameterValidationMessages
        missing={field.missing}
        shortSecureValue={field.shortSecureValue}
        t={t}
      />
    </div>
  );
}

type RunbookRunDialogProps = {
  open: boolean;
  runtimeParameters: RuntimeParameterDefinition[];
  runtimeParameterValues: Record<string, string>;
  visibleSecureParameters: Set<string>;
  missingRuntimeRequiredParameterCount: number;
  onValueChange: (key: string, value: string) => void;
  onToggleVisibility: (key: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
  t: TranslationFn;
};

export function RunbookRunDialog({
  open,
  runtimeParameters,
  runtimeParameterValues,
  visibleSecureParameters,
  missingRuntimeRequiredParameterCount,
  onValueChange,
  onToggleVisibility,
  onCancel,
  onSubmit,
  t,
}: RunbookRunDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="w-full max-w-lg rounded-lg border border-border bg-background shadow-lg"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium">
            {t("runbooks.runbook.runParameters")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("runbooks.runbook.valuesAreUsedForThis")}
          </p>
        </div>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-4">
          {runtimeParameters.map((parameter) => (
            <RuntimeParameterInputRow
              key={parameter.key}
              parameter={parameter}
              value={runtimeParameterValues[parameter.key] ?? ""}
              visible={visibleSecureParameters.has(parameter.key)}
              onValueChange={onValueChange}
              onToggleVisibility={onToggleVisibility}
              t={t}
            />
          ))}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground/60">
            {t("runbooks.runbook.secureValuesAreHiddenFrom")}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted"
            >
              {t("common.actions.cancel")}
            </button>
            <button
              type="submit"
              disabled={missingRuntimeRequiredParameterCount > 0}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-[hsl(var(--primary-hover))] disabled:opacity-40"
            >
              {t("runbooks.runbook.run")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
