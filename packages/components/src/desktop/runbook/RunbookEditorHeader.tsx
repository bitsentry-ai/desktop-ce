import type { ReactNode } from "react";

import {
  AlertTriangle,
  Check,
  ChevronDown,
  History,
  Hourglass,
  Play,
  SquarePen,
  Trash2,
  Upload,
} from "../../icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { RunbookRecord } from "../../services";
import type {
  IdleTimeoutPreset,
  RunbookMetadataIssues,
  TranslationFn,
} from "./types";

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
  extraActions?: ReactNode;
  t: TranslationFn;
};

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
  t,
}: RunbookEditorHeaderProps) {
  const hasMetaIssue =
    metaIssues.titleIssue !== null || metaIssues.descriptionIssue !== null;

  return (
    <div
      data-tour="runbooks-editor-header"
      className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <input
          value={runbook.title}
          onChange={(event) => {
            onTitleChange(event.target.value);
          }}
          onBlur={onTitleBlur}
          className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground"
          placeholder={t("runbooks.runbook.runbookTitle")}
        />
        <input
          value={runbook.description}
          onChange={(event) => {
            onDescriptionChange(event.target.value);
          }}
          onBlur={onDescriptionBlur}
          className="mt-0.5 w-full bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
          placeholder={t("runbooks.runbook.addADescription")}
        />
      </div>
      {hasMetaIssue && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={t("runbooks.runbook.runbookMetadataWarning")}
              className="flex size-7 shrink-0 cursor-help items-center justify-center text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle size={16} aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="end" className="max-w-xs">
            <p className="font-medium">
              {t("runbooks.runbook.botMayNotDetectThis")}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              {metaIssues.titleIssue !== null && (
                <li>{metaIssues.titleIssue}</li>
              )}
              {metaIssues.descriptionIssue !== null && (
                <li>{metaIssues.descriptionIssue}</li>
              )}
            </ul>
          </TooltipContent>
        </Tooltip>
      )}
      <span className="shrink-0 text-xs text-muted-foreground">
        {runbook.actions.length} action
        {runbook.actions.length !== 1 && "s"}
      </span>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("runbooks.runbook.executionIdleTimeout")}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
              >
                <Hourglass size={12} />
                <span>
                  {t("runbooks.runbook.timeout")} {currentTimeoutLabel}
                </span>
                <ChevronDown size={12} />
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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onExport}
            aria-label={t("runbooks.runbook.export")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted"
          >
            <Upload size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.export")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour="runbooks-history-btn"
            onClick={onOpenResults}
            aria-label={t("runbooks.runbook.viewRunbookResultHistory")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted"
          >
            <History size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.viewRunbookResultHistory")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour="runbooks-run-btn"
            onClick={onRun}
            disabled={runbook.actions.length === 0}
            aria-label={t("runbooks.runbook.runRunbook")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-primary text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
          >
            <Play size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.runRunbook")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onDelete}
            aria-label={t("runbooks.runbook.deleteRunbook")}
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 size={13} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.deleteRunbook")}
        </TooltipContent>
      </Tooltip>
      {extraActions}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour="runbooks-new-btn"
            onClick={onCreateRunbook}
            className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
          >
            <SquarePen size={12} />
            {t("common.actions.new")}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t("runbooks.runbook.newRunbook")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
