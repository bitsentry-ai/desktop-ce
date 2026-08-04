import { AlertCircle, CheckCircle, Loader2 } from "@bitsentry-ce/components/icons";
import { cn } from "@bitsentry-ce/components/lib/utils";
import { Button } from "@bitsentry-ce/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bitsentry-ce/components/ui/dialog";
import type {
  RunbookExportArtifactV1,
  RunbookImportOptions,
  RunbookImportSummary,
} from "@bitsentry-ce/components/services";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { ReactNode } from "react";

export type RunbookImportConflictPolicy = Extract<
  NonNullable<RunbookImportOptions["conflictPolicy"]>,
  "duplicate" | "skip"
>;

type RunbookImportDialogProps = {
  open: boolean;
  artifact: RunbookExportArtifactV1 | null;
  conflictPolicy: RunbookImportConflictPolicy;
  includeGlobals: boolean;
  previewSummary: RunbookImportSummary | null;
  resultSummary: RunbookImportSummary | null;
  previewLoading: boolean;
  importLoading: boolean;
  errorMessage: string | null;
  onConflictPolicyChange: (policy: RunbookImportConflictPolicy) => void;
  onIncludeGlobalsChange: (nextValue: boolean) => void;
  onImport: () => void;
  onClose: () => void;
};

const CONFLICT_POLICIES: Array<{
  value: RunbookImportConflictPolicy;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    value: "duplicate",
    labelKey: "runbooks.runbookImportDialog.duplicate",
    descriptionKey: "runbooks.runbookImportDialog.createImportedCopies",
  },
  {
    value: "skip",
    labelKey: "runbooks.runbookImportDialog.skip",
    descriptionKey: "runbooks.runbookImportDialog.leaveConflictingRunbooks",
  },
];

const DESKTOP_PRODUCT_LABEL = "BitSentry Desktop";
const DASHBOARD_PRODUCT_LABEL = "Dashboard";

function formatProductLabel(
  product: "bitsentry-desktop" | "dashboard" | undefined,
  t: (key: string) => string,
): string {
  switch (product) {
      case "bitsentry-desktop":
        return DESKTOP_PRODUCT_LABEL;
      case "dashboard":
        return DASHBOARD_PRODUCT_LABEL;
      default:
        return t("runbooks.runbookImportDialog.unknown");
    }
}

function formatExportedAt(
  value: string | undefined,
  t: (key: string) => string,
): string {
  if (value === undefined || value.length === 0) {
      return t("runbooks.runbookImportDialog.unknown");
    }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

type ImportSummaryCount = "imported" | "skipped" | "failed";

function formatSummaryCountLabel(
  key: ImportSummaryCount,
  isPreview: boolean,
  t: (key: string) => string,
): string {
  if (isPreview) {
      switch (key) {
        case "imported":
          return t("runbooks.runbookImportDialog.willImport");
        case "skipped":
          return t("runbooks.runbookImportDialog.willSkip");
        case "failed":
          return t("runbooks.runbookImportDialog.willFail");
      }
    }

  switch (key) {
    case "imported":
      return t("runbooks.runbookImportDialog.imported");
    case "skipped":
      return t("runbooks.runbookImportDialog.skipped");
    case "failed":
      return t("runbooks.runbookImportDialog.failed");
  }
}

function formatResultStatus(
  status: "imported" | "skipped" | "failed",
  isPreview: boolean,
  t: (key: string) => string,
): string {
  if (!isPreview) {
      return t(`runbooks.runbookImportDialog.${status}`);
    }

  switch (status) {
    case "imported":
      return t("runbooks.runbookImportDialog.willImport");
    case "skipped":
      return t("runbooks.runbookImportDialog.willSkip");
    case "failed":
      return t("runbooks.runbookImportDialog.willFail");
  }
}

function resultStatusClass(status: "imported" | "skipped" | "failed"): string {
  switch (status) {
    case "imported":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600";
    case "skipped":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
  }
}

function resultDetailLines(result: {
  reason?: string;
  warnings?: string[];
}): string[] {
  const lines: string[] = [];
  if (result.reason !== undefined && result.reason.length > 0) {
    lines.push(result.reason);
  }
  if (Array.isArray(result.warnings)) {
    lines.push(...result.warnings.filter((warning) => warning.trim().length > 0));
  }
  return lines;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- The import preview, conflict controls, and result state share one dialog lifecycle and must remain visually consistent.
export function RunbookImportDialog({
  open,
  artifact,
  conflictPolicy,
  includeGlobals,
  previewSummary,
  resultSummary,
  previewLoading,
  importLoading,
  errorMessage,
  onConflictPolicyChange,
  onIncludeGlobalsChange,
  onImport,
  onClose,
}: RunbookImportDialogProps) {
  const { t } = useTranslation();
  const summary = resultSummary ?? previewSummary;
  const isResult = resultSummary !== null;
  const secureGlobalsNeedingValues =
    artifact?.globals?.filter(
      (globalVariable) =>
        globalVariable.secure === true && globalVariable.redacted === true,
    ).length ?? 0;

  let dialogTitle = t("runbooks.runbookImportDialog.importRunbooks");
  let dialogDescription = t(
    "runbooks.runbookImportDialog.previewTheArtifactChooseHow",
  );
  if (isResult) {
    dialogTitle = t("runbooks.runbookImportDialog.importSummary");
    dialogDescription = t(
      "runbooks.runbookImportDialog.reviewTheImportedRunbooksAnd",
    );
  }

  let conflictPolicyContent: ReactNode = null;
  if (!isResult) {
    let globalsImportContent: ReactNode = null;
    if (artifact?.globals !== undefined && artifact.globals.length > 0) {
      let pluralSuffix = "s";
      if (artifact.globals.length === 1) {
        pluralSuffix = "";
      }

      globalsImportContent = (
        <label className="mt-4 flex items-start gap-3 rounded-lg border border-border px-3 py-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={includeGlobals}
            onChange={(event) => {
              onIncludeGlobalsChange(event.target.checked);
            }}
            disabled={importLoading}
          />
          <span>
            {t("runbooks.runbookImportDialog.import")} {artifact.globals.length}{" "}
            {t("runbooks.runbookImportDialog.globalVariable")}
            {pluralSuffix} {t("runbooks.runbookImportDialog.asWell")}
          </span>
        </label>
      );
    }

    let secureGlobalsWarning: ReactNode = null;
    if (secureGlobalsNeedingValues > 0) {
      let pluralSuffix = "s";
      if (secureGlobalsNeedingValues === 1) {
        pluralSuffix = "";
      }

      secureGlobalsWarning = (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-amber-700 dark:text-amber-300">
          {secureGlobalsNeedingValues}{" "}
          {t("runbooks.runbookImportDialog.secureGlobal")}
          {pluralSuffix}{" "}
          {t("runbooks.runbookImportDialog.willBeImportedWithoutOriginal")}
        </div>
      );
    }

    conflictPolicyContent = (
      <div className="rounded-lg border border-border p-4">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbookImportDialog.conflictPolicy")}
        </p>
        <div className="mt-3 grid gap-2">
          {CONFLICT_POLICIES.map((policy) => {
            let policyClassName = "border-border hover:bg-muted/40";
            let radioClassName = "border-border text-transparent";
            if (conflictPolicy === policy.value) {
              policyClassName = "border-primary bg-primary/5";
              radioClassName = "border-primary bg-primary text-primary-foreground";
            }

            return (
              <button
                key={policy.value}
                type="button"
                onClick={() => {
                  onConflictPolicyChange(policy.value);
                }}
                className={cn(
                  "rounded-lg border px-3 py-3 text-left transition-colors",
                  policyClassName,
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">{t(policy.labelKey)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(policy.descriptionKey)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      radioClassName,
                    )}
                  >
                    •
                  </span>
                </div>
              </button>
            );
          })}
        </div>
        {globalsImportContent}
        {secureGlobalsWarning}
      </div>
    );
  }

  let summaryLabel = t("runbooks.runbookImportDialog.preview");
  if (isResult) {
    summaryLabel = t("runbooks.runbookImportDialog.importResult");
  }

  let previewLoadingContent: ReactNode = null;
  if (previewLoading) {
    previewLoadingContent = (
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        {t("runbooks.runbookImportDialog.preparingPreview")}
      </span>
    );
  }

  let errorContent: ReactNode = null;
  if (errorMessage !== null && errorMessage.length > 0) {
    errorContent = (
      <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-3 text-sm text-destructive">
        <div className="flex items-start gap-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      </div>
    );
  }

  let summaryContent: ReactNode = null;
  if (summary !== null) {
    summaryContent = (
      <>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(["imported", "skipped", "failed"] as const).map((key) => (
            <div
              key={key}
              className="rounded-lg border border-border bg-muted/20 px-3 py-3"
            >
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                {formatSummaryCountLabel(key, !isResult, t)}
              </p>
              <p className="mt-1 text-2xl font-semibold">{summary[key]}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 grid gap-2">
          {summary.results.map((result) => {
            let statusIcon: ReactNode = null;
            if (result.status === "imported") {
              statusIcon = <CheckCircle size={12} />;
            } else if (result.status === "failed") {
              statusIcon = <AlertCircle size={12} />;
            }

            return (
              <div
                key={result.runbookId ?? result.title}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border px-3 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{result.title}</p>
                  {resultDetailLines(result).map((line) => (
                    <p
                      key={line}
                      className="mt-1 text-xs text-muted-foreground"
                    >
                      {line}
                    </p>
                  ))}
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium",
                    resultStatusClass(result.status),
                  )}
                >
                  {statusIcon}
                  {formatResultStatus(result.status, !isResult, t)}
                </span>
              </div>
            );
          })}
        </div>
      </>
    );
  } else if (!previewLoading && errorMessage === null) {
    summaryContent = (
      <p className="mt-3 text-sm text-muted-foreground">
        {t("runbooks.runbookImportDialog.selectAnArtifactToPreview")}
      </p>
    );
  }

  let closeLabel = t("runbooks.runbookImportDialog.cancel");
  if (isResult) {
    closeLabel = t("runbooks.runbookImportDialog.close");
  }

  let importButton: ReactNode = null;
  if (!isResult) {
    let importLabel = t("runbooks.runbookImportDialog.importRunbooks_2");
    if (importLoading) {
      importLabel = t("runbooks.runbookImportDialog.importing");
    }

    importButton = (
      <Button
        onClick={onImport}
        disabled={importLoading || previewLoading || errorMessage !== null}
      >
        {importLabel}
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !importLoading) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-h-[88vh] overflow-hidden p-0 sm:max-w-4xl"
        onInteractOutside={(event) => {
          if (importLoading) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (importLoading) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="border-b border-border px-6 py-5">
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[calc(88vh-14rem)] gap-4 overflow-y-auto px-6 py-5">
          <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-3">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                {t("runbooks.runbookImportDialog.exportedFrom")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {formatProductLabel(artifact?.exportedBy?.product, t)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                {t("runbooks.runbookImportDialog.exportedAt")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {formatExportedAt(artifact?.exportedAt, t)}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                {t("runbooks.runbookImportDialog.runbooks")}
              </p>
              <p className="mt-1 text-sm font-medium">
                {artifact?.runbooks.length ?? 0}
              </p>
            </div>
          </div>

          {conflictPolicyContent}

          <div className="rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground/60">
                {summaryLabel}
              </p>
              {previewLoadingContent}
            </div>

            {errorContent}
            {summaryContent}
          </div>
        </div>

        <DialogFooter className="border-t border-border px-6 py-4">
          <Button variant="outline" onClick={onClose} disabled={importLoading}>
            {closeLabel}
          </Button>
          {importButton}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
