import { useContext } from "react";
import type * as React from "react";
import { ThemeContext } from "../theme/ThemeContext";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import type { ToasterProps } from "./sonner.types";

/**
 * Every toast sits on the popover surface with foreground text, so titles and
 * descriptions stay readable (AA) in both themes. The type only colors a thin
 * accent bar and the icon, never the whole toast.
 */
const toastClassNames = {
  toast: [
    "group toast !gap-3 !rounded-lg !border !border-border !bg-popover !p-4 !pl-5 !pr-11 !text-popover-foreground",
    "!shadow-[0_4px_12px_hsl(var(--shadow-color)/0.1)]",
    "before:absolute before:inset-y-3 before:left-2 before:w-[3px] before:rounded-full before:content-['']",
    "data-[type=error]:before:bg-[hsl(var(--destructive))] data-[type=warning]:before:bg-[hsl(var(--warning))]",
    "data-[type=success]:before:bg-[hsl(var(--success))] data-[type=info]:before:bg-[hsl(var(--info))]",
  ].join(" "),
  title: "!text-sm !font-medium !leading-5 !text-foreground",
  description: "!text-[13px] !leading-5 !text-muted-foreground",
  icon: "!mt-0.5 !self-start",
  // Toast actions are corrective (Try again, Review), so they are neutral secondary buttons; green stays for primary
  // actions on the page.
  actionButton:
    "!h-8 !rounded-md !border !border-solid !border-[hsl(var(--input))] !bg-[hsl(var(--card))] !px-3 !text-xs !font-medium !text-[hsl(var(--foreground))] hover:!bg-[hsl(var(--secondary-hover))]",
  cancelButton: "!h-7 !rounded-md !bg-muted !px-2.5 !text-xs !text-muted-foreground",
  // Inside the top-right corner with a 28px target, instead of floating off the top-left edge.
  closeButton:
    "!left-auto !right-2 !top-2 !size-7 !translate-x-0 !translate-y-0 !rounded-md !border-0 !bg-transparent !text-muted-foreground hover:!bg-accent hover:!text-foreground [&>svg]:!size-4",
};

/** Each type's icon in its status text colour (AA on the popover surface), matching the accent bar. */
const toastIcons: ToasterProps["icons"] = {
  success: <CircleCheck aria-hidden="true" className="size-4 !text-[hsl(var(--status-success-text))]" />,
  info: <Info aria-hidden="true" className="size-4 !text-[hsl(var(--status-info-text))]" />,
  warning: <TriangleAlert aria-hidden="true" className="size-4 !text-[hsl(var(--status-warning-text))]" />,
  error: <CircleAlert aria-hidden="true" className="size-4 !text-[hsl(var(--status-destructive-text))]" />,
};

const Toaster = ({ ...props }: ToasterProps) => {
  // Follow the app's own theme (light or dark) when one is provided.
  const theme = useContext(ThemeContext)?.theme ?? "system";
  const style: React.CSSProperties & { "--width"?: string } = {
    "--width": "420px",
    ...props.style,
  };

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      // Wider than Sonner's 356px default to accommodate longer translations
      // (French strings run ~20% longer than English). Honors caller override.
      style={style}
      icons={toastIcons}
      // Every toast can be dismissed with a visible 28px target in its top-right corner.
      closeButton
      toastOptions={{ classNames: toastClassNames }}
      {...props}
    />
  );
};

export { Toaster };
export { toast } from "sonner";
export type { ToasterProps } from "sonner";
