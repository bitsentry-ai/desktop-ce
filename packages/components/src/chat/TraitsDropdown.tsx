/**
 * TraitsDropdown - standard dropdown menu for model-specific options.
 *
 * Trigger shows a compact summary of selected values.
 * Dropdown renders each option group as section headers with checkmark-selected items.
 * Hidden entirely if the model has no composerOptions.
 */

import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";
import { Check, ChevronDown } from "lucide-react";
import type {
  ComposerOptionDescriptor,
  ComposerSelectOption,
  ComposerBooleanOption,
} from "../llm/modelCatalog";
import { useTranslation } from "@bitsentry-ce/i18n";

interface TraitsDropdownProps {
  options: ComposerOptionDescriptor[];
  values: Record<string, string | boolean>;
  onChange: (id: string, value: string | boolean) => void;
  disabled?: boolean;
}

function translateLabel(t: (key: string) => string, value: string): string {
  if (value.startsWith("common.")) {
    return t(value);
  }

  return value;
}

function getSelectedLabel(
  option: ComposerSelectOption,
  value: string | undefined,
  t: (key: string) => string,
): string {
  const selected =
    value ??
    option.options.find((optionValue) => optionValue.isDefault === true)
      ?.value ??
    option.options[0]?.value;
  const selectedOption = option.options.find(
    (optionValue) => optionValue.value === selected,
  );
  if (selectedOption?.shortLabel !== undefined) {
    return translateLabel(t, selectedOption.shortLabel);
  }
  if (selectedOption?.label !== undefined) {
    return translateLabel(t, selectedOption.label);
  }
  if (selected !== undefined) {
    return selected;
  }

  return "";
}

function getSelectSummaryLabel(
  option: ComposerSelectOption,
  rawValue: string | boolean | undefined,
  t: (key: string) => string,
): string {
  return getSelectedLabel(option, typeof rawValue === "string" ? rawValue : undefined, t);
}

function getBooleanSummaryLabel(
  option: ComposerBooleanOption,
  rawValue: string | boolean | undefined,
  t: (key: string) => string,
): string {
  const checked = typeof rawValue === "boolean" ? rawValue : option.defaultValue === true;
  return checked && option.shortLabel !== undefined ? translateLabel(t, option.shortLabel) : "";
}

function buildSummary(
  options: ComposerOptionDescriptor[],
  values: Record<string, string | boolean>,
  t: (key: string) => string,
): string {
  const parts: string[] = [];
  for (const option of options) {
    const rawValue = values[option.id];
    const label = option.type === "select"
      ? getSelectSummaryLabel(option, rawValue, t)
      : getBooleanSummaryLabel(option, rawValue, t);
    if (label.length > 0) parts.push(label);
  }
  if (parts.length > 0) {
    return parts.join(" | ");
  }

  return t("common.traitsDropdown.traits");
}

export function TraitsDropdown({
  options,
  values,
  onChange,
  disabled,
}: TraitsDropdownProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (
        open &&
        ref.current !== null &&
        target instanceof Node &&
        !ref.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [open]);

  if (options.length === 0) return null;

  const summary = buildSummary(options, values, t);

  return (
    <div ref={ref} className="relative z-20 shrink-0">
      <button
        type="button"
        onClick={() => { setOpen((value) => !value); }}
        disabled={disabled}
        className={cn(
          "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
          "text-muted-foreground/70 hover:bg-accent hover:text-foreground/80",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "bg-accent text-foreground/80",
        )}
      >
        <span className="max-w-[10rem] truncate">{summary}</span>
        <ChevronDown size={10} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 min-w-[200px] rounded-xl border border-border bg-popover py-1.5 shadow-lg">
          {options.map((option) => {
            const rawValue = values[option.id];
            if (option.type === "select") {
              let selectedValue: string | undefined;
              if (typeof rawValue === "string") {
                selectedValue = rawValue;
              }

              return (
                <SelectSection
                  key={option.id}
                  option={option}
                  value={selectedValue}
                  onChange={(value) => { onChange(option.id, value); }}
                />
              );
            }

            let checkedValue: boolean | undefined;
            if (typeof rawValue === "boolean") {
              checkedValue = rawValue;
            }

            return (
              <BooleanSection
                key={option.id}
                option={option}
                value={checkedValue}
                onChange={(value) => { onChange(option.id, value); }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function SelectSection({
  option,
  value,
  onChange,
}: {
  option: ComposerSelectOption;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const selected =
    value ??
    option.options.find((optionValue) => optionValue.isDefault === true)
      ?.value ??
    option.options[0]?.value;
  return (
    <div>
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {translateLabel(t, option.label)}
      </div>
      {option.options.map((choice) => {
        let className = "text-muted-foreground";
        if (selected === choice.value) {
          className = "text-foreground";
        }

        let defaultLabel = null;
        if (choice.isDefault === true) {
          defaultLabel = (
            <span className="ml-auto text-[10px] text-muted-foreground/50">
              {t("common.traitsDropdown.default")}
            </span>
          );
        }

        return (
          <button
            key={choice.value}
            type="button"
            onClick={() => { onChange(choice.value); }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              className,
            )}
          >
            <span className="w-4 shrink-0">
              {selected === choice.value && (
                <Check size={12} className="text-primary" />
              )}
            </span>
            <span>{translateLabel(t, choice.label)}</span>
            {defaultLabel}
          </button>
        );
      })}
    </div>
  );
}

function BooleanSection({
  option,
  value,
  onChange,
}: {
  option: ComposerBooleanOption;
  value: boolean | undefined;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  let checked = false;
  if (value !== undefined) {
    checked = value;
  } else if (option.defaultValue !== undefined) {
    checked = option.defaultValue;
  }

  const offLabel = t("common.traitsDropdown.off");
  const onLabel = t("common.traitsDropdown.on");
  return (
    <div>
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {translateLabel(t, option.label)}
      </div>
      {[true, false].map((valueOption) => {
        let className = "text-muted-foreground";
        if (checked === valueOption) {
          className = "text-foreground";
        }

        let valueLabel = offLabel;
        if (valueOption) {
          valueLabel = onLabel;
        }

        let defaultLabel = null;
        if (valueOption === option.defaultValue) {
          defaultLabel = (
            <span className="ml-auto text-[10px] text-muted-foreground/50">
              {t("common.traitsDropdown.default_2")}
            </span>
          );
        }

        return (
          <button
            key={String(valueOption)}
            type="button"
            onClick={() => { onChange(valueOption); }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              className,
            )}
          >
            <span className="w-4 shrink-0">
              {checked === valueOption && (
                <Check size={12} className="text-primary" />
              )}
            </span>
            <span>{valueLabel}</span>
            {defaultLabel}
          </button>
        );
      })}
    </div>
  );
}
