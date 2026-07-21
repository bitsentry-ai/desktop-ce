import type { ReactNode } from "react";

import { ArrowDown, Plus } from "../../icons";
import { cn } from "../../lib/utils";
import type { RunbookActionRecord } from "../../services";
import type { TranslationFn } from "./types";

type UseSortableRuntime = (options: {
  id: string;
  index: number;
  disabled: boolean;
  group: string;
  type: string;
  accept: string;
}) => {
  ref: (node: HTMLElement | null) => void;
  isDragging: boolean;
  isDragSource: boolean;
  isDropTarget: boolean;
};

type SortableActionWrapperProps = {
  id: string;
  index: number;
  disabled: boolean;
  showConnector: boolean;
  useSortableRuntime: UseSortableRuntime;
  children: (api: {
    isDragging: boolean;
    isDragSource: boolean;
    isDropTarget: boolean;
  }) => ReactNode;
};

function SortableActionWrapper({
  id,
  index,
  disabled,
  showConnector,
  useSortableRuntime,
  children,
}: SortableActionWrapperProps) {
  const { ref, isDragging, isDragSource, isDropTarget } = useSortableRuntime({
    id,
    index,
    disabled,
    group: "runbook-actions",
    type: "runbook-action",
    accept: "runbook-action",
  });
  const showDropGap = isDropTarget && !isDragSource;

  // The connector arrow lives inside the sortable element so it moves with
  // its card while dnd-kit reorders the DOM; a sibling connector would be
  // left behind mid-drag and cards would pile up between stale arrows.
  return (
    <div
      ref={ref}
      className={cn(
        "transition-[padding,margin] duration-150 ease-out",
        showDropGap && "py-5",
      )}
    >
      {children({ isDragging, isDragSource, isDropTarget })}
      {showConnector && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none flex h-7 items-center justify-center text-muted-foreground/35",
            (isDragSource || isDragging) && "opacity-0",
          )}
        >
          <ArrowDown size={15} strokeWidth={1.8} />
        </div>
      )}
    </div>
  );
}

type RunbookActionListProps = {
  actions: RunbookActionRecord[];
  useSortableRuntime: UseSortableRuntime;
  isExpanded: (action: RunbookActionRecord) => boolean;
  renderExpandedCard: (
    action: RunbookActionRecord,
    index: number,
  ) => ReactNode;
  renderCollapsedCard: (
    action: RunbookActionRecord,
    index: number,
    api: {
      isDragging: boolean;
      isDragSource: boolean;
      isDropTarget: boolean;
    },
  ) => ReactNode;
  onAddActionAt: (index: number) => void;
  className?: string;
  t: TranslationFn;
};

export function RunbookActionList({
  actions,
  useSortableRuntime,
  isExpanded,
  renderExpandedCard,
  renderCollapsedCard,
  onAddActionAt,
  className,
  t,
}: RunbookActionListProps) {
  return (
    <div
      data-tour="runbooks-actions-list"
      className={cn("max-w-2xl", className)}
    >
      {actions.map((action, index) => {
        const expanded = isExpanded(action);
        const showConnector = !expanded && index < actions.length - 1;

        return (
          <div key={action.id}>
            <SortableActionWrapper
              id={action.id}
              index={index}
              disabled={expanded}
              showConnector={showConnector}
              useSortableRuntime={useSortableRuntime}
            >
              {(sortableApi) => {
                if (expanded) {
                  return renderExpandedCard(action, index);
                }

                return renderCollapsedCard(action, index, sortableApi);
              }}
            </SortableActionWrapper>
            {expanded && (
              <div className="flex justify-center py-2">
                <button
                  data-tour="runbooks-add-action"
                  onClick={() => {
                    onAddActionAt(index + 1);
                  }}
                  disabled={action.title.trim().length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Plus size={11} />
                  {t("runbooks.runbook.addActionHere")}
                </button>
              </div>
            )}
          </div>
        );
      })}
      {actions.length > 0 && !actions.some(isExpanded) && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => {
              onAddActionAt(actions.length);
            }}
            className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-muted-foreground/40 transition-colors hover:bg-muted/30 hover:text-muted-foreground"
          >
            <Plus size={11} />
            {t("runbooks.runbook.addAction")}
          </button>
        </div>
      )}
    </div>
  );
}
