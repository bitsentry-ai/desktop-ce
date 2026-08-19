import { useEffect, useState } from "react";

import { ChevronDown } from "../../icons";
import { cn } from "../../lib/utils";
import {
  getModelDisplayName,
  resolveCatalogModel,
} from "../../llm/modelCatalog";
import type { RunbookActionTypeFieldsProps } from "./RunbookActionFieldShared";

type RunbookLlmActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  | "action"
  | "actionMeta"
  | "llmModelOptions"
  | "llmProviderHint"
  | "llmProviderLabelsByKey"
  | "modelBorderClass"
  | "modelDropdownOpen"
  | "modelDropdownRef"
  | "onModelDropdownOpenChange"
  | "onActionChange"
  | "t"
>;

export function RunbookLlmActionFields({
  action,
  actionMeta,
  llmModelOptions,
  llmProviderHint,
  llmProviderLabelsByKey,
  modelBorderClass,
  modelDropdownOpen,
  modelDropdownRef,
  onModelDropdownOpenChange,
  onActionChange,
  t,
}: RunbookLlmActionFieldsProps) {
  const resolvedActionModel = resolveCatalogModel(action.llmModel);
  const currentDisplayName = resolvedActionModel === undefined
    ? action.llmModel ?? ""
    : getModelDisplayName(resolvedActionModel.providerKey, resolvedActionModel.modelId);
  const [modelQuery, setModelQuery] = useState(currentDisplayName);
  const [modelError, setModelError] = useState<string | null>(null);

  useEffect(() => {
    setModelQuery(currentDisplayName);
    setModelError(null);
  }, [action.id, action.llmModel, action.llmProviderKey, currentDisplayName]);

  const findSelectableModel = (value: string) => {
    const resolved = resolveCatalogModel(value);
    const resolvedOption = resolved === undefined
      ? undefined
      : llmModelOptions.find(
        (option) => option.providerKey === resolved.providerKey && option.modelId === resolved.modelId,
      );
    if (resolvedOption !== undefined) return resolvedOption;

    const slug = value.trim().toLowerCase().replace(/\s+/g, "-");
    return llmModelOptions.find((option) =>
      [option.modelId, option.label]
        .some((candidate) => candidate.trim().toLowerCase().replace(/\s+/g, "-") === slug),
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t(actionMeta.llm.fieldLabelKey)}
        </label>
        <textarea
          value={action.prompt ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              prompt: event.target.value,
            });
          }}
          rows={6}
          placeholder={t(actionMeta.llm.fieldPlaceholderKey)}
          className="w-full resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.model")}
        </label>
        <div ref={modelDropdownRef} className="relative">
          <div
            className={cn(
              "flex w-full cursor-text items-center rounded-lg border bg-muted/30 transition-colors",
              modelBorderClass,
            )}
            onClick={() => {
              onModelDropdownOpenChange(true);
            }}
          >
            <input
              type="text"
              value={modelQuery}
              onChange={(event) => {
                const nextModel = event.target.value;
                setModelQuery(nextModel);
                if (nextModel.trim().length === 0) {
                  setModelError(null);
                  onActionChange({ ...action, llmModel: undefined, llmProviderKey: undefined });
                } else {
                  const matchedOption = findSelectableModel(nextModel);
                  if (matchedOption === undefined) {
                    setModelError("Unknown model. Choose a model from the list; the saved value must be its canonical ID.");
                  } else {
                    setModelError(null);
                    onActionChange({
                      ...action,
                      llmModel: matchedOption.modelId,
                      llmProviderKey: matchedOption.providerKey,
                    });
                  }
                }
                if (!modelDropdownOpen) {
                  onModelDropdownOpenChange(true);
                }
              }}
              onFocus={() => {
                onModelDropdownOpenChange(true);
              }}
              placeholder={t("runbooks.runbook.leaveBlankToUseThe")}
              className="flex-1 bg-transparent px-3 py-2 text-xs outline-none"
            />
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onModelDropdownOpenChange(!modelDropdownOpen);
              }}
              className="px-2 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              tabIndex={-1}
            >
              <ChevronDown
                size={12}
                className={cn(
                  "transition-transform",
                  modelDropdownOpen && "rotate-180",
                )}
              />
            </button>
          </div>
          {modelDropdownOpen &&
            (() => {
              const normalizedModel = action.llmModel?.trim() ?? "";
              const selectedOptionMatch =
                normalizedModel.length > 0 &&
                llmModelOptions.some((option) => {
                  if (option.modelId !== normalizedModel) {
                    return false;
                  }

                  if (action.llmProviderKey === undefined) {
                    return true;
                  }

                  return option.providerKey === action.llmProviderKey;
                });
              let filter = "";
              if (!selectedOptionMatch) {
                filter = normalizedModel.toLowerCase();
              }

              const filtered = llmModelOptions.filter(
                (option) =>
                  filter.length === 0 ||
                  option.modelId.toLowerCase().includes(filter) ||
                  option.label.toLowerCase().includes(filter),
              );
              if (filtered.length === 0) {
                return null;
              }

              return (
                <div className="absolute z-50 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg">
                  {filtered.map((option) => (
                    <button
                      key={`${option.providerKey}:${option.modelId}`}
                      type="button"
                      onClick={() => {
                        onActionChange({
                          ...action,
                          llmModel: option.modelId,
                          llmProviderKey: option.providerKey,
                        });
                        setModelQuery(option.label);
                        setModelError(null);
                        onModelDropdownOpenChange(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-1.5 text-xs transition-colors hover:bg-muted",
                        action.llmModel === option.modelId &&
                          "bg-primary/5 text-primary",
                      )}
                    >
                      <span className="truncate font-medium">
                        {option.modelId}
                      </span>
                      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground/60">
                        {llmProviderLabelsByKey[option.providerKey] ??
                          option.providerKey}
                      </span>
                    </button>
                  ))}
                </div>
              );
            })()}
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground/60">
          {llmProviderHint}
        </p>
        {modelError !== null && (
          <p className="mt-1 text-[11px] text-destructive">{modelError}</p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground/60">
          {t("runbooks.runbook.youCanAlsoUsePlaceholders")}{" "}
          <code>{"{{target_model}}"}</code>.
        </p>
      </div>
    </div>
  );
}
