import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";

/**
 * Why the composer cannot send and where to fix it, as one compact line inside the composer it blocks. The title
 * shows; the longer explanation is read to screen readers and shown on hover, so the warning never pushes the
 * conversation up.
 */
export function ComposerBlockedNotice({
  title,
  description,
  actionLabel,
  onAction,
  retryLabel,
  onRetry,
}: {
  title: string;
  description?: string;
  actionLabel: string;
  onAction: () => void;
  /** Shown before the main action when the cause can be retried in place, such as a failed load. */
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const hasDescription = description !== undefined && description.length > 0;
  return (
    <div role="status" className="flex min-w-0 items-center gap-2 py-2 pl-3.5 pr-2 sm:pl-4">
      <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-[hsl(var(--warning-text))]" />
      <p
        className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-foreground"
        title={hasDescription ? `${title} ${description}` : title}
      >
        {title}
        {hasDescription && <span className="sr-only"> {description}</span>}
      </p>
      {retryLabel !== undefined && onRetry !== undefined && (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry} className="h-7 shrink-0 px-2.5 text-xs max-sm:h-11">
          {retryLabel}
        </Button>
      )}
      <Button type="button" variant="outline" size="sm" onClick={onAction} className="h-7 shrink-0 px-2.5 text-xs max-sm:h-11">
        {actionLabel}
      </Button>
    </div>
  );
}
