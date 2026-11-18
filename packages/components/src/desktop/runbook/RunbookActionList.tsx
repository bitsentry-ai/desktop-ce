import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { ArrowDown, Plus } from "../../icons";
import { cn } from "../../lib/utils";
import type { RunbookActionRecord } from "../../services";
import { RUNBOOK_ADD_ACTION_BUTTON_CLASS } from "./runbookButtonStyles";
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
      data-runbook-action-id={id}
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
            "pointer-events-none flex h-7 items-center justify-center text-muted-foreground/50",
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
  const actionsListRef = useRef<HTMLDivElement>(null);
  const validatedActionsRef = useRef(actions);
  const [renderRevision, setRenderRevision] = useState(0);

  useLayoutEffect(() => {
    if (validatedActionsRef.current === actions) {
      return;
    }

    validatedActionsRef.current = actions;
    const actionsList = actionsListRef.current;
    if (actionsList === null) {
      return;
    }

    const renderedActionIds = Array.from(actionsList.children)
      .map((child) => child.getAttribute("data-runbook-action-id"))
      .filter((id): id is string => id !== null);
    const expectedActionIds = actions.map((action) => action.id);
    const isActionOrderStale =
      renderedActionIds.length !== expectedActionIds.length ||
      renderedActionIds.some((id, index) => id !== expectedActionIds[index]);

    if (isActionOrderStale) {
      setRenderRevision((revision) => revision + 1);
    }
  }, [actions]);

  return (
    <div
      key={renderRevision}
      ref={actionsListRef}
      data-tour="runbooks-actions-list"
      className={cn("max-w-2xl", className)}
    >
      {actions.map((action, index) => {
        const expanded = isExpanded(action);
        const showConnector = !expanded && index < actions.length - 1;

        return (
          <SortableActionWrapper
            key={action.id}
            id={action.id}
            index={index}
            disabled={expanded}
            showConnector={showConnector}
            useSortableRuntime={useSortableRuntime}
          >
            {(sortableApi) => (
              <>
                {expanded
                  ? renderExpandedCard(action, index)
                  : renderCollapsedCard(action, index, sortableApi)}
                {expanded && (
                  <div className="flex py-3">
                    <button
                      type="button"
                      data-tour="runbooks-add-action"
                      onClick={() => {
                        onAddActionAt(index + 1);
                      }}
                      disabled={action.title.trim().length === 0}
                      className={RUNBOOK_ADD_ACTION_BUTTON_CLASS}
                    >
                      <Plus size={14} aria-hidden="true" />
                      {t("runbooks.runbook.addActionHere")}
                    </button>
                  </div>
                )}
              </>
            )}
          </SortableActionWrapper>
        );
      })}
      {actions.length > 0 && !actions.some(isExpanded) && (
        <div className="mt-3 flex">
          <button
            type="button"
            onClick={() => {
              onAddActionAt(actions.length);
            }}
            className={RUNBOOK_ADD_ACTION_BUTTON_CLASS}
          >
            <Plus size={14} aria-hidden="true" />
            {t("runbooks.runbook.addAction")}
          </button>
        </div>
      )}
    </div>
  );
}
