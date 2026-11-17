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
    "!shadow-[0_10px_30px_-10px_hsl(var(--shadow-color)/0.25),0_2px_6px_-2px_hsl(var(--shadow-color)/0.1)]",
    "before:absolute before:inset-y-3 before:left-2 before:w-[3px] before:rounded-full before:content-['']",
    "data-[type=error]:before:bg-[hsl(var(--destructive))] data-[type=warning]:before:bg-[hsl(var(--warning))]",
    "data-[type=success]:before:bg-[hsl(var(--success))] data-[type=info]:before:bg-[hsl(var(--info))]",
  ].join(" "),
  title: "!text-[13px] !font-medium !leading-5 !text-foreground",
  description: "!text-[12.5px] !leading-[1.125rem] !text-muted-foreground",
  icon: "!mt-0.5 !self-start",
  actionButton: "!h-7 !rounded-md !bg-primary !px-2.5 !text-xs !font-medium !text-primary-foreground",
  cancelButton: "!h-7 !rounded-md !bg-muted !px-2.5 !text-xs !text-muted-foreground",
  // Inside the top-right corner with a 28px target, instead of floating off the top-left edge.
  closeButton:
    "!left-auto !right-2 !top-2 !size-7 !translate-x-0 !translate-y-0 !rounded-md !border-0 !bg-transparent !text-muted-foreground hover:!bg-accent hover:!text-foreground [&>svg]:!size-3.5",
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
      toastOptions={{ classNames: toastClassNames }}
      {...props}
    />
  );
};

export { Toaster };
export { toast } from "sonner";
export type { ToasterProps } from "sonner";
