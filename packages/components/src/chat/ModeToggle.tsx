/**
 * ModeToggle — single toggle button between Build and Plan modes.
 *
 * Build is the default state (ghost style). Clicking switches to Plan
 * (highlighted style). Clicking again returns to Build.
 *
 * Hidden if the selected provider doesn't support Plan mode.
 */

import { Hammer, ClipboardList } from "lucide-react";
import { cn } from "../lib/utils";
import { type InteractionMode } from "./types";
import { useTranslation } from "@bitsentry-ce/i18n";

interface ModeToggleProps {
  value: InteractionMode;
  onChange: (mode: InteractionMode) => void;
  disabled?: boolean;
}

export function ModeToggle({ value, onChange, disabled }: ModeToggleProps) {
  const { t } = useTranslation();
  const isPlan = value === "plan";
  let nextMode: InteractionMode = "plan";
  let title = t("common.modeToggle.switchToPlanMode");
  let icon = <Hammer size={12} className="shrink-0" />;
  let label = t("common.modeToggle.build");
  let stateClassName = "text-muted-foreground hover:bg-accent hover:text-foreground/80";

  if (isPlan) {
    nextMode = "default";
    title = t("common.modeToggle.planModeClickToReturn");
    icon = <ClipboardList size={12} className="shrink-0" />;
    label = t("common.modeToggle.plan");
    stateClassName = "bg-primary/10 text-primary hover:bg-primary/15";
  }

  return (
    <button
      type="button"
      onClick={() => { onChange(nextMode); }}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        stateClassName,
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
