import { AlertTriangle, CircleAlert } from "lucide-react";
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
  /** Shown before the main action, in the same style, when the cause can be retried in place, such as a failed load. */
  retryLabel?: string;
  onRetry?: () => void;
}) {
  const hasDescription = description !== undefined && description.length > 0;
  // A notice that can be retried is a failed load, so it takes the error icon; one that needs setup stays neutral.
  const canRetry = retryLabel !== undefined && onRetry !== undefined;
  return (
    // Below 640px the message takes its own line and the actions sit under it, so the message is never cut off.
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 py-2 pl-3.5 pr-2 sm:flex-nowrap sm:pl-4">
      {canRetry ? (
        <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      ) : (
        <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-[hsl(var(--warning-text))]" />
      )}
      <p
        className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground max-sm:basis-[calc(100%-1.5rem)] sm:truncate"
        title={hasDescription ? `${title} ${description}` : title}
      >
        {title}
        {hasDescription && <span className="sr-only"> {description}</span>}
      </p>
      <div className="flex shrink-0 items-center gap-2 max-sm:ml-auto">
        {canRetry && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="h-7 px-2.5 text-xs max-sm:h-11">
            {retryLabel}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onAction} className="h-7 px-2.5 text-xs max-sm:h-11">
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
