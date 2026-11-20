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

/** "Show more" sits on its own line under the clamped description, so no sentence fades out under it; "Show less" follows the full text. */
const DESCRIPTION_TOGGLE_CLASS =
  "rounded-sm text-xs font-medium leading-[18px] text-foreground/80 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
          className="mt-0.5 flex size-5 shrink-0 cursor-help items-center justify-center text-muted-foreground hover:text-foreground"
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

/**
 * "New runbook" as a compact icon button beside History: on a runbook's own page it is a secondary action, so it
 * gives its width to the title and execution controls. The tooltip and accessible name spell it out.
 */
function NewRunbookButton({
  onCreateRunbook,
  t,
}: Pick<RunbookEditorHeaderProps, "onCreateRunbook" | "t">) {
  const label = t("runbooks.runbook.newRunbook");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-tour="runbooks-new-btn"
          onClick={onCreateRunbook}
          aria-label={label}
          className={RUNBOOK_ICON_BUTTON_CLASS}
        >
          <SquarePen size={14} aria-hidden="true" />
        </button>
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
  onOpenResults,
  onCreateRunbook,
  overflowActions,
  t,
}: Pick<RunbookEditorHeaderProps, "onExport" | "onDelete" | "onOpenResults" | "onCreateRunbook" | "t"> & {
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
        {/* Below 640px History and New runbook live here instead of in the toolbar. */}
        <DropdownMenuItem onSelect={onOpenResults} className={cn(MENU_ITEM_CLASS, "sm:hidden")}>
          <History size={14} aria-hidden="true" />
          {t("runbooks.runbook.viewRunbookResultHistory")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCreateRunbook} className={cn(MENU_ITEM_CLASS, "sm:hidden")}>
          <SquarePen size={14} aria-hidden="true" />
          {t("runbooks.runbook.newRunbook")}
        </DropdownMenuItem>
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
 * Tab) swaps in the textarea so the full text can be edited. When the clamp
 * hides text, a "Show more" button under it expands the description in place.
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
  const previewRef = useRef<HTMLParagraphElement>(null);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const showPreview = !editing && value.length > 0;

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (preview === null || expanded) return;
    const measure = () => {
      setClamped(preview.scrollHeight > preview.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(preview);
    return () => {
      observer.disconnect();
    };
  }, [value, expanded, showPreview]);

  return (
    <div className="relative mt-0.5">
      {showPreview && (
        <div className="relative">
          <p
            ref={previewRef}
            aria-hidden="true"
            title={expanded ? undefined : value}
            onClick={() => {
              ref.current?.focus();
            }}
            className={cn(
              "max-w-[48rem] cursor-text break-words text-sm leading-5 text-muted-foreground",
              !expanded && "line-clamp-2 max-sm:line-clamp-1",
            )}
          >
            {value}
          </p>
          {!expanded && clamped && (
            <button
              type="button"
              aria-expanded={false}
              onClick={() => {
                setExpanded(true);
              }}
              className={cn(DESCRIPTION_TOGGLE_CLASS, "mt-0.5 max-sm:py-2")}
            >
              {t("runbooks.runbook.showFullDescription")}
            </button>
          )}
        </div>
      )}
      {showPreview && expanded && (
        <button
          type="button"
          aria-expanded
          onClick={() => {
            setExpanded(false);
          }}
          className={cn(DESCRIPTION_TOGGLE_CLASS, "mt-0.5 max-sm:py-2")}
        >
          {t("runbooks.runbook.showShortDescription")}
        </button>
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
          "block max-h-10 w-full max-w-[48rem] resize-none overflow-hidden break-words bg-transparent text-sm leading-5 text-muted-foreground outline-none placeholder:text-muted-foreground/70 focus:overflow-y-auto",
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
      {/* Title and description with Run at their right; the toolbar, with its
          labelled controls and ⋯, on its own row below at every width, so the
          runbook's name never shares a line with its settings.
          The toolbar keeps the execution settings and History visible; the
          export actions and Delete live in the ⋯ menu at every width. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2.5">
        <div className="col-start-1 row-start-1 flex min-w-0 items-start gap-1.5">
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
              className="block max-h-[48px] w-full resize-none overflow-hidden break-words bg-transparent text-lg font-semibold leading-6 tracking-[-0.015em] text-foreground outline-none placeholder:text-muted-foreground focus:overflow-y-auto"
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

        <div className="col-start-2 row-start-1 flex items-center justify-end">
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

        <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground [@container(max-width:27.99rem)]:hidden">
            {t("runbooks.runbooks.actionCount", {
              count: runbook.actions.length,
            })}
          </span>
          {/* Execution settings stay together as one group. */}
          <div
            role="group"
            aria-label={t("runbooks.runbook.executionSettings")}
            className="flex min-w-0 flex-wrap items-center gap-2"
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
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* History and New runbook move into ⋯ below 640px, leaving the title, settings and Run. */}
            <span className="contents max-sm:hidden">
              <HeaderIconButton
                label={t("runbooks.runbook.viewRunbookResultHistory")}
                onClick={onOpenResults}
                icon={<History size={14} aria-hidden="true" />}
                dataTour="runbooks-history-btn"
              />
              <NewRunbookButton onCreateRunbook={onCreateRunbook} t={t} />
            </span>
            <RunbookOverflowMenu
              onExport={onExport}
              onDelete={onDelete}
              onOpenResults={onOpenResults}
              onCreateRunbook={onCreateRunbook}
              overflowActions={overflowActions}
              t={t}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
