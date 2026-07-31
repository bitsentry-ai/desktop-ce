/**
 * AccessSelector — dropdown for tool execution autonomy.
 * Always visible in the toolbar. Defaults to Safe Tools on new sessions.
 */

import { useState, useRef, useEffect } from "react";
import { cn } from "../lib/utils";
import { ChevronDown, Shield, Unlock } from "lucide-react";
import {
  type AccessLevel,
  ACCESS_LEVEL_LABELS,
  ACCESS_LEVEL_DESCRIPTIONS,
} from "./types";
import { useTranslation } from "@bitsentry-ce/i18n";

const ACCESS_ICONS: Record<AccessLevel, typeof Shield> = {
  "auto-accept-edits": Shield,
  "full-access": Unlock,
};

const ACCESS_LEVELS: AccessLevel[] = [
  "auto-accept-edits",
  "full-access",
];

interface AccessSelectorProps {
  value: AccessLevel;
  onChange: (level: AccessLevel) => void;
  disabled?: boolean;
  /** Subset of levels to show. Defaults to both levels. */
  levels?: AccessLevel[];
}

export function AccessSelector({
  value,
  onChange,
  disabled,
  levels = ACCESS_LEVELS,
}: AccessSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        open &&
        ref.current !== null &&
        !ref.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => { document.removeEventListener("mousedown", handleClickOutside); };
  }, [open]);

  const Icon = ACCESS_ICONS[value];

  return (
    <div ref={ref} className="relative z-20 shrink-0">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); }}
        disabled={disabled}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
          "text-muted-foreground/70 hover:bg-accent hover:text-foreground/80",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "bg-accent text-foreground/80",
        )}
      >
        <Icon size={12} className="shrink-0" />
        <span className="hidden sm:inline">{t(ACCESS_LEVEL_LABELS[value])}</span>
        <ChevronDown size={10} className="shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 min-w-[220px] rounded-xl border border-border bg-popover p-1.5 shadow-lg">
          {levels.map((level) => {
            const LevelIcon = ACCESS_ICONS[level];
            const isSelected = value === level;
            let iconClassName = "text-muted-foreground";
            if (isSelected) {
              iconClassName = "text-primary";
            }

            return (
              <button
                key={level}
                type="button"
                onClick={() => {
                  onChange(level);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent",
                  isSelected && "bg-accent/60",
                )}
              >
                <LevelIcon
                  size={14}
                  className={cn(
                    "shrink-0",
                    iconClassName,
                  )}
                />
                <div className="text-left">
                  <div
                    className={cn(
                      "text-sm",
                      isSelected && "font-medium",
                    )}
                  >
                    {t(ACCESS_LEVEL_LABELS[level])}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t(ACCESS_LEVEL_DESCRIPTIONS[level])}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
