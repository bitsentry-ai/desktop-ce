import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  History,
  Hourglass,
  MoreHorizontal,
  Play,
  SquarePen,
  Trash2,
  Upload,
} from "../../icons";
import { cn } from "../../lib/utils";
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import type { RunbookRecord } from "../../services";
import { RUNBOOK_ICON_BUTTON_CLASS } from "./runbookButtonStyles";
import type {
  IdleTimeoutPreset,
  RunbookMetadataIssues,
  TranslationFn,
} from "./types";

/** An infrequent runbook action shown among the header's secondary actions. */
export type RunbookHeaderMenuAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
};

type RunbookEditorHeaderProps = {
  runbook: RunbookRecord;
  metaIssues: RunbookMetadataIssues;
  currentTimeoutMinutes: number;
  currentTimeoutLabel: string;
  idleTimeoutPresets: readonly IdleTimeoutPreset[];
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  onDescriptionChange: (value: string) => void;
  onDescriptionBlur: () => void;
  onIdleTimeoutChange: (value: number) => void;
  onExport: () => void;
  onOpenResults: () => void;
  onRun: () => void;
  onDelete: () => void;
  onCreateRunbook: () => void;
  /** Compact execution controls grouped with the timeout picker. */
  extraActions?: ReactNode;
  /** Extra infrequent actions listed after Export in the ⋯ menu. */
  overflowActions?: readonly RunbookHeaderMenuAction[];
  t: TranslationFn;
};

const LINE_BREAKS = /[\r\n]+/g;

function singleLine(value: string): string {
  return value.replace(LINE_BREAKS, " ");
}

function preventLineBreak(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
    event.preventDefault();
  }
}

/**
 * Grows a one-line textarea with its content so a long title or description
 * wraps instead of being cut off; CSS max-height caps it at two lines.
 */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }

    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${String(element.scrollHeight)}px`;
    };
    resize();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    let lastWidth = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== lastWidth) {
        lastWidth = element.clientWidth;
        resize();
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [value]);

  return ref;
}

function MetadataWarning({
  metaIssues,
  t,
}: {
  metaIssues: RunbookMetadataIssues;
  t: TranslationFn;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={t("runbooks.runbook.runbookMetadataWarning")}
          className="mt-0.5 flex size-5 shrink-0 cursor-help items-center justify-center text-amber-600 dark:text-amber-400"
        >
          <AlertTriangle size={16} aria-hidden="true" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs">
        <p className="font-medium">
          {t("runbooks.runbook.botMayNotDetectThis")}
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {metaIssues.titleIssue !== null && <li>{metaIssues.titleIssue}</li>}
          {metaIssues.descriptionIssue !== null && (
            <li>{metaIssues.descriptionIssue}</li>
          )}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

function IdleTimeoutPicker({
  currentTimeoutMinutes,
  currentTimeoutLabel,
  idleTimeoutPresets,
  onIdleTimeoutChange,
  t,
}: Pick<
  RunbookEditorHeaderProps,
  | "currentTimeoutMinutes"
  | "currentTimeoutLabel"
  | "idleTimeoutPresets"
  | "onIdleTimeoutChange"
  | "t"
>) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("runbooks.runbook.executionIdleTimeout")}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:h-11"
            >
              <Hourglass size={12} aria-hidden="true" />
              <span>
                {/* The tightest header keeps only the value; the button's
                    aria-label still names the setting. */}
                <span className="[@container(max-width:27.99rem)]:sr-only">
                  {t("runbooks.runbook.timeout")}{" "}
                </span>
                {currentTimeoutLabel}
              </span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.executionIdleTimeout_2")}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-40">
        <div className="px-2 pb-1.5 pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("runbooks.runbook.idleTimeout")}
        </div>
        {idleTimeoutPresets.map((preset) => {
          const selected = currentTimeoutMinutes === preset.value;
          return (
            <DropdownMenuItem
              key={preset.value}
              onSelect={() => {
                onIdleTimeoutChange(preset.value);
              }}
              className="flex items-center justify-between"
            >
              <span>{preset.label}</span>
              {selected && <Check size={12} />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type HeaderIconButtonProps = {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  dataTour?: string;
};

function HeaderIconButton({
  label,
  onClick,
  icon,
  dataTour,
}: HeaderIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-tour={dataTour}
          onClick={onClick}
          aria-label={label}
          className={RUNBOOK_ICON_BUTTON_CLASS}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** "New runbook" as an outlined button; only the icon stays on the tightest header. */
function NewRunbookButton({
  onCreateRunbook,
  t,
}: Pick<RunbookEditorHeaderProps, "onCreateRunbook" | "t">) {
  const label = t("runbooks.runbook.newRunbook");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-tour="runbooks-new-btn"
          onClick={onCreateRunbook}
          aria-label={label}
          className="gap-1.5 px-2.5 max-sm:h-11 max-sm:min-w-11 [&_svg]:size-3.5"
        >
          <SquarePen aria-hidden="true" />
          <span className="[@container(max-width:27.99rem)]:sr-only">
            {label}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

const MENU_ITEM_CLASS = "gap-2 max-sm:min-h-11";

/**
 * The ⋯ menu, at every header width: export actions first, then Delete on its
 * own after a separator so the destructive action never sits beside Run.
 */
function RunbookOverflowMenu({
  onExport,
  onDelete,
  overflowActions,
  t,
}: Pick<RunbookEditorHeaderProps, "onExport" | "onDelete" | "t"> & {
  overflowActions: readonly RunbookHeaderMenuAction[];
}) {
  const label = t("runbooks.runbook.moreRunbookActions");
  // Non-modal so the delete confirmation dialog can take focus right after
  // the menu closes without fighting the menu's pointer lock.
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              className={RUNBOOK_ICON_BUTTON_CLASS}
            >
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onExport} className={MENU_ITEM_CLASS}>
          <Upload size={14} aria-hidden="true" />
          {t("runbooks.runbook.exportRunbook")}
        </DropdownMenuItem>
        {overflowActions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={action.onSelect}
            className={MENU_ITEM_CLASS}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className={cn(
            MENU_ITEM_CLASS,
            "text-destructive focus:bg-destructive/10 focus:text-destructive",
          )}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("runbooks.runbook.deleteRunbook")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The description reads as up to two clamped lines; focusing it (click or
 * Tab) swaps in the textarea so the full text can be edited.
 */
function DescriptionField({
  value,
  onChange,
  onBlur,
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  t: TranslationFn;
}) {
  const ref = useAutoHeight(value);
  const [editing, setEditing] = useState(false);
  const showPreview = !editing && value.length > 0;

  return (
    <div className="relative mt-0.5">
      {showPreview && (
        <p
          aria-hidden="true"
          title={value}
          onClick={() => {
            ref.current?.focus();
          }}
          className="line-clamp-2 cursor-text break-words text-[13px] leading-[18px] text-muted-foreground"
        >
          {value}
        </p>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        onChange={(event) => {
          onChange(singleLine(event.target.value));
        }}
        onKeyDown={preventLineBreak}
        onFocus={() => {
          setEditing(true);
        }}
        onBlur={() => {
          setEditing(false);
          onBlur();
        }}
        aria-label={t("runbooks.runbook.addADescription")}
        className={cn(
          "block max-h-[36px] w-full resize-none overflow-hidden break-words bg-transparent text-[13px] leading-[18px] text-muted-foreground outline-none placeholder:text-muted-foreground/70 focus:overflow-y-auto",
          showPreview && "sr-only",
        )}
        placeholder={t("runbooks.runbook.addADescription")}
      />
    </div>
  );
}

const NO_MENU_ACTIONS: readonly RunbookHeaderMenuAction[] = [];

export function RunbookEditorHeader({
  runbook,
  metaIssues,
  currentTimeoutMinutes,
  currentTimeoutLabel,
  idleTimeoutPresets,
  onTitleChange,
  onTitleBlur,
  onDescriptionChange,
  onDescriptionBlur,
  onIdleTimeoutChange,
  onExport,
  onOpenResults,
  onRun,
  onDelete,
  onCreateRunbook,
  extraActions,
  overflowActions = NO_MENU_ACTIONS,
  t,
}: RunbookEditorHeaderProps) {
  const hasMetaIssue =
    metaIssues.titleIssue !== null || metaIssues.descriptionIssue !== null;
  const titleRef = useAutoHeight(runbook.title);

  return (
    <div
      data-tour="runbooks-editor-header"
      className="bs-page-header shrink-0 border-b border-border px-4 py-3 [container-type:inline-size]"
    >
      {/* Three areas on a grid, placed by the header's own width:
          - under 28rem: the title takes the first row, the execution
            settings the second, and the icon buttons (left) and Run (right)
            the third, so every control sits in a clear group.
          - 28rem to 60rem: title with Run at its right; the toolbar on the
            row below.
          - 60rem and wider: title, toolbar and Run on one row.
          The toolbar keeps the execution settings and History visible; the
          export actions and Delete live in the ⋯ menu at every width. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5 [@container(min-width:60rem)]:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-1.5 [@container(max-width:27.99rem)]:col-span-2">
          <div className="min-w-0 flex-1">
            <textarea
              ref={titleRef}
              rows={1}
              value={runbook.title}
              onChange={(event) => {
                onTitleChange(singleLine(event.target.value));
              }}
              onKeyDown={preventLineBreak}
              onBlur={onTitleBlur}
              aria-label={t("runbooks.runbook.runbookTitle")}
              className="block max-h-[44px] w-full resize-none overflow-hidden break-words bg-transparent text-base font-semibold leading-[22px] text-foreground outline-none placeholder:text-muted-foreground focus:overflow-y-auto"
              placeholder={t("runbooks.runbook.runbookTitle")}
            />
            <DescriptionField
              value={runbook.description}
              onChange={onDescriptionChange}
              onBlur={onDescriptionBlur}
              t={t}
            />
          </div>
          {hasMetaIssue && <MetadataWarning metaIssues={metaIssues} t={t} />}
        </div>

        <div className="col-start-2 row-start-1 flex items-center justify-end [@container(max-width:27.99rem)]:row-start-3 [@container(min-width:60rem)]:col-start-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                data-tour="runbooks-run-btn"
                onClick={onRun}
                disabled={runbook.actions.length === 0}
                aria-label={t("runbooks.runbook.runRunbook")}
                className="gap-1.5 px-3.5 font-semibold max-sm:h-11 max-sm:px-4 max-sm:text-sm [&_svg]:size-3.5"
              >
                <Play aria-hidden="true" className="fill-current" />
                {t("runbooks.runbook.run")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("runbooks.runbook.runRunbook")}
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2 [@container(max-width:27.99rem)]:contents [@container(min-width:60rem)]:col-span-1 [@container(min-width:60rem)]:col-start-2 [@container(min-width:60rem)]:row-start-1 [@container(min-width:60rem)]:justify-end">
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground [@container(max-width:27.99rem)]:hidden">
            {t("runbooks.runbooks.actionCount", {
              count: runbook.actions.length,
            })}
          </span>
          {/* Execution settings stay together as one group. */}
          <div
            role="group"
            aria-label={t("runbooks.runbook.executionSettings")}
            className="flex min-w-0 flex-wrap items-center gap-2 [@container(max-width:27.99rem)]:col-span-2 [@container(max-width:27.99rem)]:row-start-2"
          >
            <IdleTimeoutPicker
              currentTimeoutMinutes={currentTimeoutMinutes}
              currentTimeoutLabel={currentTimeoutLabel}
              idleTimeoutPresets={idleTimeoutPresets}
              onIdleTimeoutChange={onIdleTimeoutChange}
              t={t}
            />
            {extraActions}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2 [@container(max-width:27.99rem)]:col-start-1 [@container(max-width:27.99rem)]:row-start-3 [@container(max-width:27.99rem)]:ml-0 [@container(min-width:60rem)]:ml-0">
            <HeaderIconButton
              label={t("runbooks.runbook.viewRunbookResultHistory")}
              onClick={onOpenResults}
              icon={<History size={14} aria-hidden="true" />}
              dataTour="runbooks-history-btn"
            />
            <NewRunbookButton onCreateRunbook={onCreateRunbook} t={t} />
            <RunbookOverflowMenu
              onExport={onExport}
              onDelete={onDelete}
              overflowActions={overflowActions}
              t={t}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
