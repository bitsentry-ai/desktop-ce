import { BookOpen, Download, History, SquarePen, Upload } from "../../icons";
import DashboardLayout from "../../layout/DashboardLayout";
import type { RunbookRecord } from "../../services";
import { Button } from "../../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import { RunbookEmptyState } from "./RunbookEmptyState";
import { RUNBOOK_ICON_BUTTON_CLASS } from "./runbookButtonStyles";
import type { TranslationFn } from "./types";

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

type RunbookLibraryViewProps = {
  loading: boolean;
  runbooks: RunbookRecord[];
  onOpenImportDialog: () => void;
  onCreateRunbook: () => void;
  onOpenRunbook: (runbookId: string) => void;
  onExportRunbooks: (runbookId: string) => void;
  onOpenRunbookResults: (runbookId: string) => void;
  t: TranslationFn;
};

export function RunbookLibraryView({
  loading,
  runbooks,
  onOpenImportDialog,
  onCreateRunbook,
  onOpenRunbook,
  onExportRunbooks,
  onOpenRunbookResults,
  t,
}: RunbookLibraryViewProps) {
  let runbookListContent = (
    <div
      data-tour="runbooks-list"
      className="divide-y divide-border overflow-hidden rounded-lg border border-border"
    >
      {runbooks.map((runbook) => {
        let description = runbook.description;
        if (description.length === 0) {
          description = t("runbooks.runbooks.noDescription");
        }

        return (
          <div
            key={runbook.id}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <button
              type="button"
              onClick={() => {
                onOpenRunbook(runbook.id);
              }}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <BookOpen size={14} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {runbook.title}
                </div>
                <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                  {description}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground/70">
                  <span>
                    {t("runbooks.runbooks.actionCount", {
                      count: runbook.actions.length,
                    })}
                  </span>
                  <span className="text-muted-foreground/30">•</span>
                  <span>
                    {t("runbooks.runbook.updated")}{" "}
                    {formatRelativeTime(runbook.updatedAt)}
                  </span>
                </div>
              </div>
            </button>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    onExportRunbooks(runbook.id);
                  }}
                  aria-label={t("runbooks.runbook.export")}
                  className={RUNBOOK_ICON_BUTTON_CLASS}
                >
                  <Upload size={14} aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("runbooks.runbook.export")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    onOpenRunbookResults(runbook.id);
                  }}
                  aria-label={t("runbooks.runbook.viewRunbookResults")}
                  className={RUNBOOK_ICON_BUTTON_CLASS}
                >
                  <History size={14} aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t("runbooks.runbook.viewRunbookResults")}
              </TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );

  if (runbooks.length === 0) {
    runbookListContent = (
      <RunbookEmptyState
        icon={<BookOpen />}
        title={t("runbooks.runbook.noRunbooksYetTitle")}
        description={t("runbooks.runbook.noRunbooksYetDescription")}
        actions={
          <>
            <Button
              type="button"
              onClick={onCreateRunbook}
              className="max-sm:h-11"
            >
              <SquarePen aria-hidden="true" />
              {t("runbooks.runbook.newRunbook")}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onOpenImportDialog}
              className="max-sm:h-11"
            >
              <Download aria-hidden="true" />
              {t("runbooks.runbook.importRunbooks")}
            </Button>
          </>
        }
      />
    );
  }

  if (loading) {
    runbookListContent = (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("runbooks.runbook.loadingRunbooks")}
      </div>
    );
  }

  return (
    <DashboardLayout mainClassName="flex flex-col overflow-hidden p-0">
      <div className="bs-page-header flex min-h-[3.25rem] shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">
          {t("runbooks.runbook.allRunbooks")}
        </span>
        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {t("runbooks.runbooks.runbookCount", { count: runbooks.length })}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tour="runbooks-import-btn"
              onClick={onOpenImportDialog}
              className="gap-1.5 max-sm:h-11 [&_svg]:size-3.5"
            >
              <Download aria-hidden="true" />
              {t("common.actions.import")}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("runbooks.runbook.importRunbooks")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="sm"
              data-tour="runbooks-new-btn"
              onClick={onCreateRunbook}
              className="gap-1.5 max-sm:h-11 [&_svg]:size-3.5"
            >
              <SquarePen aria-hidden="true" />
              {t("common.actions.new")}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("runbooks.runbook.newRunbook")}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {runbookListContent}
      </div>
    </DashboardLayout>
  );
}
