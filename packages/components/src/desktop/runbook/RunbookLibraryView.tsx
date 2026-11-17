import { BookOpen, Download, History, SquarePen, Upload } from "../../icons";
import DashboardLayout from "../../layout/DashboardLayout";
import type { RunbookRecord } from "../../services";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
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
  let runbookCountSuffix = "s";
  if (runbooks.length === 1) {
    runbookCountSuffix = "";
  }

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

        let actionCountSuffix = "s";
        if (runbook.actions.length === 1) {
          actionCountSuffix = "";
        }

        return (
          <div
            key={runbook.id}
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <button
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
                    {runbook.actions.length} action{actionCountSuffix}
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
                  onClick={() => {
                    onExportRunbooks(runbook.id);
                  }}
                  aria-label={t("runbooks.runbook.export")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted"
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
                  onClick={() => {
                    onOpenRunbookResults(runbook.id);
                  }}
                  aria-label={t("runbooks.runbook.viewRunbookResults")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted"
                >
                  <History size={13} />
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
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-muted-foreground">
        <BookOpen size={36} className="opacity-25" />
        <p className="text-sm">
          {t("runbooks.runbook.noRunbooksYetImportOne")}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onOpenImportDialog}
            className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-xs transition-colors hover:bg-muted"
          >
            <Download size={12} />
            {t("runbooks.runbook.importRunbooks")}
          </button>
          <button
            onClick={onCreateRunbook}
            className="flex items-center gap-1.5 rounded-lg border border-dashed border-border px-4 py-2 text-xs transition-colors hover:border-primary/40 hover:text-foreground"
          >
            <SquarePen size={12} />
            {t("runbooks.runbook.newRunbook")}
          </button>
        </div>
      </div>
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
        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {runbooks.length} runbook{runbookCountSuffix}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-tour="runbooks-import-btn"
              onClick={onOpenImportDialog}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-muted"
            >
              <Download size={12} />
              {t("common.actions.import")}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("runbooks.runbook.importRunbooks")}
          </TooltipContent>
        </Tooltip>
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

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {runbookListContent}
      </div>
    </DashboardLayout>
  );
}
