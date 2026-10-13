import type * as React from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";
import type { ToasterProps } from "./sonner.types";

const Toaster = ({ ...props }: ToasterProps) => {
  const themeContext: { theme?: string } = useTheme();
  const theme = themeContext.theme ?? "system";
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
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
