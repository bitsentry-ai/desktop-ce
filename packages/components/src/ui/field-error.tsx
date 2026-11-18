import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";

import { cn } from "../lib/utils";

/**
 * The message under an invalid field: a red icon and 13px text that says what to fix. Pair it with `aria-invalid`
 * on the field and point the field's `aria-describedby` at this element's `id`.
 */
export function FieldError({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <p id={id} className={cn("mt-1.5 flex items-start gap-1.5 text-[13px] leading-[18px] text-[hsl(var(--destructive-text))]", className)}>
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
