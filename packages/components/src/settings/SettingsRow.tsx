import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "../lib/utils";

/** Section heading inside a settings page: 15px/22px semibold. */
export const settingsSectionTitleClass = "text-[15px] font-semibold leading-[22px] text-foreground";
/** Section subtitle and row description: 13px/20px muted. */
export const settingsDescriptionClass = "text-[13px] leading-5 text-muted-foreground";
/** Row label: 14px/20px medium. */
export const settingsLabelClass = "block text-sm font-medium leading-5 text-foreground";

/**
 * How the control sits beside its label.
 * - `field`: selects and inputs. Full width under the label on narrow screens, a fixed 240px column on wide ones.
 * - `compact`: buttons. Under the label at their own width on narrow screens, right-aligned on wide ones.
 * - `switch`: switches and checkboxes. Always on the right, since they never squeeze the label.
 */
export type SettingsRowControlLayout = "field" | "compact" | "switch";

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Overrides the description colour, such as an error tone; size and leading stay. */
  descriptionClassName?: string;
  /** Extra lines under the description, such as a "last checked" note. */
  details?: ReactNode;
  /** The control the label names; renders the label as a `<label>`. */
  htmlFor?: string;
  controlLayout?: SettingsRowControlLayout;
  /** The control. With the `field` layout, give the control `w-full` so it fills its column. */
  children: ReactNode;
  id?: string;
  className?: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
}

const rowLayoutClass: Record<SettingsRowControlLayout, string> = {
  field: "flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
  compact: "flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
  switch: "flex items-center justify-between gap-4",
};

const controlLayoutClass: Record<SettingsRowControlLayout, string> = {
  field: "flex w-full min-w-0 items-center gap-2 sm:w-60 sm:shrink-0 sm:justify-end",
  compact: "flex shrink-0 items-center gap-2",
  switch: "flex shrink-0 items-center",
};

/**
 * One settings row: label and description on the left, control on the right. Below the `sm` breakpoint the control
 * moves under the text so the description keeps a readable line length.
 */
export function SettingsRow({
  label,
  description,
  descriptionClassName,
  details,
  htmlFor,
  controlLayout = "field",
  children,
  id,
  className,
  onClick,
}: SettingsRowProps) {
  const labelNode = htmlFor === undefined
    ? <p className={settingsLabelClass}>{label}</p>
    : <label htmlFor={htmlFor} className={cn(settingsLabelClass, onClick !== undefined && "cursor-pointer")}>{label}</label>;
  return (
    <div id={id} className={cn(rowLayoutClass[controlLayout], "p-4 sm:py-3", className)} onClick={onClick}>
      <div className="min-w-0 sm:flex-1">
        {labelNode}
        {description !== undefined && (
          <p className={cn(settingsDescriptionClass, descriptionClassName)}>{description}</p>
        )}
        {details}
      </div>
      <div className={controlLayoutClass[controlLayout]}>{children}</div>
    </div>
  );
}

export default SettingsRow;
