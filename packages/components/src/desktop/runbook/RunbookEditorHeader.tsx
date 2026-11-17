import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
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
  /**
   * Extra infrequent actions shown after Export: icon buttons on a wide
   * header, items in the ⋯ menu on a compact one.
   */
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

/** Header widths (border box) below this collapse the secondary icon buttons into the overflow menu. */
const COMPACT_HEADER_MAX_WIDTH = 640;

/**
 * Tracks whether the header itself (not the window) is narrower than 640px,
 * so the desktop sidebar and the dashboard navbar both get the compact
 * layout when they squeeze it. An unmeasured header (0px, as in jsdom) keeps
 * the wide layout.
 */
function useIsCompactHeader(ref: RefObject<HTMLDivElement | null>): boolean {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }

    const measure = () => {
      const { width } = element.getBoundingClientRect();
      setCompact(width > 0 && width < COMPACT_HEADER_MAX_WIDTH);
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return compact;
}

type HeaderIconButtonProps = {
  label: string;
  onClick: () => void;
  icon: ReactNode;
  dataTour?: string;
  destructive?: boolean;
};

function HeaderIconButton({
  label,
  onClick,
  icon,
  dataTour,
  destructive = false,
}: HeaderIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-tour={dataTour}
          onClick={onClick}
          aria-label={label}
          className={cn(
            RUNBOOK_ICON_BUTTON_CLASS,
            destructive &&
              "text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

type SecondaryActionProps = Pick<
  RunbookEditorHeaderProps,
  "onExport" | "onOpenResults" | "onDelete" | "onCreateRunbook" | "t"
> & {
  overflowActions: readonly RunbookHeaderMenuAction[];
};

/** Wide headers: history, export, extras, delete and New as icon buttons. */
function RunbookSecondaryIconButtons({
  onExport,
  onOpenResults,
  onDelete,
  onCreateRunbook,
  overflowActions,
  t,
}: SecondaryActionProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5 [@container(min-width:60rem)]:ml-1.5">
      <HeaderIconButton
        label={t("runbooks.runbook.viewRunbookResultHistory")}
        onClick={onOpenResults}
        icon={<History size={14} aria-hidden="true" />}
        dataTour="runbooks-history-btn"
      />
      <HeaderIconButton
        label={t("runbooks.runbook.exportRunbook")}
        onClick={onExport}
        icon={<Upload size={14} aria-hidden="true" />}
      />
      {overflowActions.map((action) => (
        <HeaderIconButton
          key={action.id}
          label={action.label}
          onClick={action.onSelect}
          icon={action.icon}
        />
      ))}
      <HeaderIconButton
        label={t("runbooks.runbook.deleteRunbook")}
        onClick={onDelete}
        icon={<Trash2 size={14} aria-hidden="true" />}
        destructive
      />
      <HeaderIconButton
        label={t("runbooks.runbook.newRunbook")}
        onClick={onCreateRunbook}
        icon={<SquarePen size={14} aria-hidden="true" />}
        dataTour="runbooks-new-btn"
      />
    </div>
  );
}

/** Compact headers: the same secondary actions behind one ⋯ button next to Run. */
function RunbookOverflowMenu({
  onExport,
  onOpenResults,
  onDelete,
  onCreateRunbook,
  overflowActions,
  t,
}: SecondaryActionProps) {
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
              // History lives in this menu here, so the tour points at it.
              data-tour="runbooks-history-btn"
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
        <DropdownMenuItem
          onSelect={onOpenResults}
          className="gap-2 max-sm:min-h-11"
        >
          <History size={14} aria-hidden="true" />
          {t("runbooks.runbook.viewRunbookResultHistory")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onExport} className="gap-2 max-sm:min-h-11">
          <Upload size={14} aria-hidden="true" />
          {t("runbooks.runbook.export")}
        </DropdownMenuItem>
        {overflowActions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            onSelect={action.onSelect}
            className="gap-2 max-sm:min-h-11"
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          onSelect={onCreateRunbook}
          className="gap-2 max-sm:min-h-11"
        >
          <SquarePen size={14} aria-hidden="true" />
          {t("runbooks.runbook.newRunbook")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onDelete}
          className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive max-sm:min-h-11"
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("runbooks.runbook.deleteRunbook")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  const descriptionRef = useAutoHeight(runbook.description);
  const headerRef = useRef<HTMLDivElement>(null);
  const compact = useIsCompactHeader(headerRef);
  const secondaryActionProps: SecondaryActionProps = {
    onExport,
    onOpenResults,
    onDelete,
    onCreateRunbook,
    overflowActions,
    t,
  };

  return (
    <div
      ref={headerRef}
      data-tour="runbooks-editor-header"
      data-compact={compact ? "true" : undefined}
      className="bs-page-header shrink-0 border-b border-border px-4 py-3 [container-type:inline-size]"
    >
      {/* Three areas on a grid, placed by the header's own width:
          - under 28rem: the title takes the first row; the secondary group
            and the [⋯][Run] pair share the second row.
          - 28rem to 60rem: title with Run at its right; the secondary group
            on the row below.
          - 60rem and wider: title, secondary group and Run on one row. */}
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

        <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 [@container(max-width:27.99rem)]:row-start-2 [@container(min-width:60rem)]:col-start-3">
          {compact && <RunbookOverflowMenu {...secondaryActionProps} />}
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

        <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-2 [@container(max-width:27.99rem)]:col-span-1 [@container(min-width:60rem)]:col-span-1 [@container(min-width:60rem)]:col-start-2 [@container(min-width:60rem)]:row-start-1 [@container(min-width:60rem)]:justify-end">
          <span className="mr-1 shrink-0 text-xs tabular-nums text-muted-foreground [@container(max-width:27.99rem)]:hidden">
            {t("runbooks.runbooks.actionCount", {
              count: runbook.actions.length,
            })}
          </span>
          {/* Execution settings stay together as one group. */}
          <div
            role="group"
            aria-label={t("runbooks.runbook.executionSettings")}
            className="flex min-w-0 flex-wrap items-center gap-1.5"
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
          {!compact && (
            <RunbookSecondaryIconButtons {...secondaryActionProps} />
          )}
        </div>
      </div>
    </div>
  );
}
