import {
  useLayoutEffect,
  useRef,
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
import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { RunbookRecord } from "../../services";
import { RUNBOOK_ICON_BUTTON_CLASS } from "./runbookButtonStyles";
import type {
  IdleTimeoutPreset,
  RunbookMetadataIssues,
  TranslationFn,
} from "./types";

/** An infrequent runbook action shown in the header's overflow menu. */
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
  /** Compact secondary controls shown next to the timeout picker. */
  extraActions?: ReactNode;
  /** Extra infrequent actions listed in the overflow menu after Export. */
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
                {t("runbooks.runbook.timeout")} {currentTimeoutLabel}
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
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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

function RunbookOverflowMenu({
  onExport,
  onDelete,
  overflowActions,
  t,
}: Pick<
  RunbookEditorHeaderProps,
  "onExport" | "onDelete" | "overflowActions" | "t"
>) {
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
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem onSelect={onExport} className="gap-2">
          <Upload size={14} aria-hidden="true" />
          {t("runbooks.runbook.export")}
        </DropdownMenuItem>
        {overflowActions?.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={action.onSelect}
            className="gap-2"
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("runbooks.runbook.deleteRunbook")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  overflowActions,
  t,
}: RunbookEditorHeaderProps) {
  const hasMetaIssue =
    metaIssues.titleIssue !== null || metaIssues.descriptionIssue !== null;
  const titleRef = useAutoHeight(runbook.title);
  const descriptionRef = useAutoHeight(runbook.description);

  return (
    <div
      data-tour="runbooks-editor-header"
      className="bs-page-header shrink-0 border-b border-border px-4 py-3 [container-type:inline-size]"
    >
      {/* Stacked rows until the header itself (not the window) is 44rem
          wide, so the desktop sidebar and the dashboard navbar both get the
          stacked layout when they squeeze it. Once side by side, the title
          block keeps at least 60% and the actions wrap in what is left. */}
      <div className="flex flex-col gap-2.5 [@container(min-width:44rem)]:flex-row [@container(min-width:44rem)]:items-start [@container(min-width:44rem)]:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-1.5 [@container(min-width:44rem)]:min-w-[60%]">
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
            <textarea
              ref={descriptionRef}
              rows={1}
              value={runbook.description}
              onChange={(event) => {
                onDescriptionChange(singleLine(event.target.value));
              }}
              onKeyDown={preventLineBreak}
              onBlur={onDescriptionBlur}
              title={runbook.description}
              aria-label={t("runbooks.runbook.addADescription")}
              className="mt-0.5 block max-h-[36px] w-full resize-none overflow-hidden break-words bg-transparent text-[13px] leading-[18px] text-muted-foreground outline-none placeholder:text-muted-foreground/70 focus:overflow-y-auto"
              placeholder={t("runbooks.runbook.addADescription")}
            />
          </div>
          {hasMetaIssue && <MetadataWarning metaIssues={metaIssues} t={t} />}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 [@container(min-width:44rem)]:justify-end">
          <span className="mr-1 shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("runbooks.runbooks.actionCount", {
              count: runbook.actions.length,
            })}
          </span>
          <IdleTimeoutPicker
            currentTimeoutMinutes={currentTimeoutMinutes}
            currentTimeoutLabel={currentTimeoutLabel}
            idleTimeoutPresets={idleTimeoutPresets}
            onIdleTimeoutChange={onIdleTimeoutChange}
            t={t}
          />
          {extraActions}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-tour="runbooks-history-btn"
                onClick={onOpenResults}
                aria-label={t("runbooks.runbook.viewRunbookResultHistory")}
                className={RUNBOOK_ICON_BUTTON_CLASS}
              >
                <History size={14} aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("runbooks.runbook.viewRunbookResultHistory")}
            </TooltipContent>
          </Tooltip>
          <RunbookOverflowMenu
            onExport={onExport}
            onDelete={onDelete}
            overflowActions={overflowActions}
            t={t}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-tour="runbooks-new-btn"
                onClick={onCreateRunbook}
                className="gap-1.5 text-foreground max-sm:h-11 [&_svg]:size-3.5"
              >
                <SquarePen aria-hidden="true" />
                {t("common.actions.new")}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("runbooks.runbook.newRunbook")}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                data-tour="runbooks-run-btn"
                onClick={onRun}
                disabled={runbook.actions.length === 0}
                aria-label={t("runbooks.runbook.runRunbook")}
                className="gap-1.5 max-sm:h-11 [&_svg]:size-3.5"
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
      </div>
    </div>
  );
}
