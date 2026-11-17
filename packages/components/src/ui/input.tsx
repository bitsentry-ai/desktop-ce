import * as React from "react";

import { cn } from "../lib/utils";

/**
 * Text input. States: a darker border on hover; a brand-green border and soft ring on keyboard focus; a red border
 * when `aria-invalid` is set; dimmed and not-allowed while disabled.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "h-9 w-full rounded-md border border-input max-sm:h-11 bg-transparent px-3 py-2 text-sm transition-colors text-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-border-hover focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 aria-[invalid=true]:border-[hsl(var(--destructive-text))] aria-[invalid=true]:focus-visible:ring-destructive/25 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
