import type { ReactNode } from "react";

type RunbookEmptyStateProps = {
  icon: ReactNode;
  title: string;
  description?: string;
  /** Buttons, primary first. */
  actions: ReactNode;
};

/**
 * Empty state for runbook collections and an empty runbook: a 32px icon,
 * a 16px title, a short explanation and 36px buttons.
 */
export function RunbookEmptyState({
  icon,
  title,
  description,
  actions,
}: RunbookEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-20 text-center">
      <div className="text-muted-foreground [&_svg]:size-8" aria-hidden="true">
        {icon}
      </div>
      <h2 className="mt-3 text-base font-semibold text-foreground">{title}</h2>
      {description !== undefined && (
        <p className="mt-1 max-w-sm text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {actions}
      </div>
    </div>
  );
}
