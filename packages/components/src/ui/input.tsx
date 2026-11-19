import * as React from "react";

import { cn } from "../lib/utils";

/**
 * Text input. States: a field border dark enough to read as a control (field-border), darker on hover; a brand-green border and a solid 2px ring, offset like a button's, on keyboard focus; a red border
 * when `aria-invalid` is set; on a muted surface and dimmed while disabled, so it never reads as an empty field.
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "h-9 w-full rounded-md border border-[hsl(var(--field-border))] max-sm:h-11 bg-transparent px-3 py-2 text-sm transition-colors text-foreground file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-[hsl(var(--field-border-hover))] focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-[invalid=true]:border-[hsl(var(--destructive-text)/0.75)] aria-[invalid=true]:focus-visible:ring-destructive disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
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
