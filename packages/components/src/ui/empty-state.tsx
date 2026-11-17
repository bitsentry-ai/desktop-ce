import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

export interface EmptyStateProps {
  /** A lucide-style icon component; it is drawn at 32px in a muted 48px tile. */
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: ReactNode;
  description?: ReactNode;
  /** The next step, such as a default-size (36px) Button or a Button with `asChild` around a link. */
  action?: ReactNode;
  className?: string;
}

/** The shared empty state: a centred icon tile, title, optional description and optional action. */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center px-4 py-12 text-center", className)}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-8 w-8" aria-hidden={true} />
      </div>
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description !== undefined && (
        <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export default EmptyState;
