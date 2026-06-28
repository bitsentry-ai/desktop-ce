import { Trash2 } from "../../icons";
import type {
  GlobalVariable,
  RunbookActionParameter,
  RunbookActionRecord,
} from "../../services";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { TranslationFn } from "./types";

const SINCE_PLACEHOLDER = "{{since}}";

function formatGlobalVariableReference(key: string) {
  return `\${globals.${key}}`;
}

function createEmptyActionParameter(): RunbookActionParameter {
  return {
    id: crypto.randomUUID(),
    key: "",
    defaultValue: "",
    required: true,
  };
}

function getParameterInjectionTarget(actionType: RunbookActionRecord["type"]) {
  if (actionType === "shell") {
    return "command";
  }

  if (actionType === "llm") {
    return "prompt or model";
  }

  if (actionType === "http") {
    return "URL, headers, or body";
  }

  if (actionType === "plugin") {
    return "auth JSON or input JSON";
  }

  return "query";
}

type RunbookActionParametersSectionProps = {
  action: RunbookActionRecord;
  parameters: RunbookActionParameter[];
  parameterErrors: string[];
  globalVariables: GlobalVariable[];
  onActionChange: (action: RunbookActionRecord) => void;
  t: TranslationFn;
};

export function RunbookActionParametersSection({
  action,
  parameters,
  parameterErrors,
  globalVariables,
  onActionChange,
  t,
}: RunbookActionParametersSectionProps) {
  const target = getParameterInjectionTarget(action.type);
  const definedKeys = parameters
    .map((parameter) => parameter.key.trim())
    .filter((key) => key.length > 0);

  const updateParameters = (
    updater: (current: RunbookActionParameter[]) => RunbookActionParameter[],
  ) => {
    const nextParameters = updater(parameters);
    let updatedParameters: RunbookActionParameter[] | undefined;
    if (nextParameters.length > 0) {
      updatedParameters = nextParameters;
    }

    onActionChange({
      ...action,
      parameters: updatedParameters,
    });
  };

  return (
    <>
      <div
        data-tour="runbook-create-parameters"
        className="mb-1.5 flex items-center justify-between"
      >
        <label className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.parameters")}
        </label>
        <button
          type="button"
          onClick={() => {
            updateParameters((current) => [
              ...current,
              createEmptyActionParameter(),
            ]);
          }}
          className="text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("runbooks.runbook.addParameter")}
        </button>
      </div>

      {definedKeys.length === 0 && (
        <p className="mb-2 text-[11px] text-muted-foreground/60">
          {t("runbooks.runbook.defineParametersToInjectDynamic")} {target}.
        </p>
      )}
      {definedKeys.length > 0 && (
        <>
          <p className="mb-2 text-[11px] text-muted-foreground/60">
            {t("runbooks.runbook.placeholdersForTarget", { target })}{" "}
            {definedKeys.map((key, index) => (
              <span key={`${key}:${String(index)}`}>
                {index > 0 && ", "}
                <code className="rounded bg-muted px-1 py-0.5">{`{{${key}}}`}</code>
              </span>
            ))}
            {t("runbooks.runbook.or")}
            <code className="rounded bg-muted px-1 py-0.5">
              {t("runbooks.runbook.paramsKey")}
            </code>
          </p>
          {globalVariables.length > 0 && (
            <p
              data-tour="runbook-create-global-reference"
              className="mb-2 text-[11px] text-muted-foreground/60"
            >
              {t("runbooks.runbook.availableGlobals")}
              {globalVariables.slice(0, 6).map((globalVariable, index) => (
                <span key={globalVariable.id}>
                  {index > 0 && ", "}
                  <code className="rounded bg-muted px-1 py-0.5">
                    {formatGlobalVariableReference(globalVariable.key)}
                  </code>
                  {globalVariable.secure === true &&
                    t("runbooks.runbook.secure_2")}
                </span>
              ))}
            </p>
          )}
        </>
      )}

      <div className="space-y-2">
        {parameters.length === 0 && (
          <p className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-2 text-[11px] text-muted-foreground/60">
            {t("runbooks.runbook.noParametersDefinedStaticText")}
          </p>
        )}
        {parameters.length > 0 && (
          <>
            {parameters.map((parameter, parameterIndex) => {
              let defaultValuePlaceholder = t("runbooks.runbook.eG1h");
              if (parameter.secure === true) {
                defaultValuePlaceholder = t(
                  "runbooks.runbook.enteredAtRunTime",
                );
              }

              return (
                <div
                  key={parameter.id}
                  className="space-y-2 rounded-lg border border-border px-3 py-2.5"
                >
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="mb-1 block cursor-help text-[9px] font-medium uppercase tracking-wider text-muted-foreground/50">
                            {t("runbooks.runbook.key")}
                          </label>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-56 text-xs"
                        >
                          {t("runbooks.runbook.thePlaceholderNameUsedIn")}{" "}
                          <code>{SINCE_PLACEHOLDER}</code>.
                        </TooltipContent>
                      </Tooltip>
                      <input
                        value={parameter.key}
                        onChange={(event) => {
                          updateParameters((current) => {
                            const nextParameters = [...current];
                            nextParameters[parameterIndex] = {
                              ...parameter,
                              key: event.target.value,
                            };
                            return nextParameters;
                          });
                        }}
                        placeholder={t("runbooks.runbook.eGSince")}
                        className="w-full rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-xs outline-none transition-colors focus:border-primary/50"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <label className="mb-1 block cursor-help text-[9px] font-medium uppercase tracking-wider text-muted-foreground/50">
                            {t("runbooks.runbook.default")}
                          </label>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-56 text-xs"
                        >
                          {t(
                            "runbooks.runbook.optionalFallbackValueInjectedAutomatically",
                          )}
                        </TooltipContent>
                      </Tooltip>
                      <input
                        value={parameter.defaultValue ?? ""}
                        onChange={(event) => {
                          if (parameter.secure === true) {
                            return;
                          }

                          updateParameters((current) => {
                            const nextParameters = [...current];
                            nextParameters[parameterIndex] = {
                              ...parameter,
                              defaultValue: event.target.value,
                            };
                            return nextParameters;
                          });
                        }}
                        disabled={parameter.secure === true}
                        placeholder={defaultValuePlaceholder}
                        className="w-full rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs outline-none transition-colors focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </div>
                    <div className="flex shrink-0 flex-col gap-1 pb-1.5">
                      <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={parameter.required !== false}
                          onChange={(event) => {
                            updateParameters((current) => {
                              const nextParameters = [...current];
                              nextParameters[parameterIndex] = {
                                ...parameter,
                                required: event.target.checked,
                              };
                              return nextParameters;
                            });
                          }}
                          className="size-3 rounded border-border"
                        />
                        {t("runbooks.runbook.required")}
                      </label>
                      <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={parameter.secure === true}
                          onChange={(event) => {
                            const secure = event.target.checked;
                            let defaultValue = parameter.defaultValue;
                            if (secure) {
                              defaultValue = undefined;
                            }

                            updateParameters((current) => {
                              const nextParameters = [...current];
                              nextParameters[parameterIndex] = {
                                ...parameter,
                                secure,
                                defaultValue,
                              };
                              return nextParameters;
                            });
                          }}
                          className="size-3 rounded border-border"
                        />
                        {t("runbooks.runbook.secureValue")}
                      </label>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        updateParameters((current) =>
                          current.filter(
                            (_item, index) => index !== parameterIndex,
                          ),
                        );
                      }}
                      className="shrink-0 pb-1.5 text-muted-foreground/40 transition-colors hover:text-destructive"
                      title={t("runbooks.runbook.removeParameter")}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {parameter.secure === true && (
                    <p className="text-[11px] text-muted-foreground/60">
                      {t("runbooks.runbook.secureValuesAreAvailableDuring")}
                    </p>
                  )}
                  <div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <label className="mb-1 block cursor-help text-[9px] font-medium uppercase tracking-wider text-muted-foreground/50">
                          {t("runbooks.runbook.description")}
                        </label>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-56 text-xs">
                        {t("runbooks.runbook.explainWhatThisParameterMeans")}
                      </TooltipContent>
                    </Tooltip>
                    <input
                      value={parameter.description ?? ""}
                      onChange={(event) => {
                        let description: string | undefined = event.target.value;
                        if (description.length === 0) {
                          description = undefined;
                        }

                        updateParameters((current) => {
                          const nextParameters = [...current];
                          nextParameters[parameterIndex] = {
                            ...parameter,
                            description,
                          };
                          return nextParameters;
                        });
                      }}
                      placeholder={t("runbooks.runbook.explainWhatThisValueMeans")}
                      className="w-full rounded-md border border-border bg-muted/30 px-2 py-1.5 text-xs outline-none transition-colors focus:border-primary/50"
                    />
                  </div>
                </div>
              );
            })}
            {parameterErrors.length > 0 && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                {parameterErrors.join(" ")}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
