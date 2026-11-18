import type { ReactNode } from "react";

import { GripVertical, Trash2 } from "../../icons";
import { cn } from "../../lib/utils";
import type { RunbookActionType } from "../../services";

type RunbookCollapsedActionCardProps = {
  index: number;
  collapsedActionTitle: ReactNode;
  actionType: RunbookActionType;
  summary: string;
  isDragging: boolean;
  isDragSource: boolean;
  isDropTarget: boolean;
  onClick: () => void;
  onDelete: () => void;
  deleteTitle: string;
  renderTypeBadge: (type: RunbookActionType) => ReactNode;
};

export function RunbookCollapsedActionCard({
  index,
  collapsedActionTitle,
  actionType,
  summary,
  isDragging,
  isDragSource,
  isDropTarget,
  onClick,
  onDelete,
  deleteTitle,
  renderTypeBadge,
}: RunbookCollapsedActionCardProps) {
  let dataTour: string | undefined;
  if (index === 0) {
    dataTour = "runbooks-first-action";
  }

  return (
    <div
      data-tour={dataTour}
      onClick={onClick}
      className={cn(
        "group flex min-h-[72px] cursor-pointer select-none items-center gap-2.5 rounded-xl border border-border bg-card py-3 pl-3 pr-3 transition-all max-sm:items-start max-sm:gap-2 max-sm:px-4 hover:border-border-hover hover:bg-card/80",
        isDragging && "opacity-70",
        isDragSource && "border-primary/30 bg-primary/5 shadow-sm",
        isDropTarget &&
          !isDragSource &&
          "border-primary/50 ring-2 ring-primary/15 shadow-md",
      )}
    >
      {/* The whole card is the drag source. The grip says so at a glance:
          always visible at reduced emphasis, full emphasis on hover/focus. */}
      <span
        aria-hidden="true"
        className="flex shrink-0 cursor-grab items-center text-muted-foreground opacity-60 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 active:cursor-grabbing max-sm:hidden"
      >
        <GripVertical size={16} />
      </span>
      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground max-sm:mt-0.5 max-sm:w-4 max-sm:text-left">
        {index + 1}
      </span>
      {/* Below 640px the grip hides (touch reorders by dragging the card) and the number, step and delete share one
          row, so the step keeps most of the width without a separate control row above it. */}
      <div className="min-w-0 flex-1 pl-1 max-sm:pl-0">
        {/* Badges wrap below a long title instead of truncating it. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-[15px] font-medium leading-[22px] text-foreground">
            {collapsedActionTitle}
          </span>
          {renderTypeBadge(actionType)}
        </div>
        <p className="mt-1 truncate font-mono text-[13px] leading-5 text-muted-foreground">
          {summary}
        </p>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        title={deleteTitle}
        aria-label={deleteTitle}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:-mr-1.5 max-sm:-mt-1.5 max-sm:size-11"
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
