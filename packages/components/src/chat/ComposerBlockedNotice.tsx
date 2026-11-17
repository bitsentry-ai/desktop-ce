import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";

/**
 * Why the composer cannot send and where to fix it. It sits inside the composer, so the page states the failure
 * once, next to the control it blocks. Below 480px the text stacks above the action.
 */
export function ComposerBlockedNotice({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div role="status" className="flex flex-col gap-3 p-4 min-[480px]:flex-row min-[480px]:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[hsl(var(--warning-text))]" />
        <p className="min-w-0 break-words text-[13px] leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">{title}</span>
          {description !== undefined && description.length > 0 && (
            <>
              {" "}
              <span>{description}</span>
            </>
          )}
        </p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onAction} className="shrink-0 self-start min-[480px]:self-auto">
        {actionLabel}
      </Button>
    </div>
  );
}
