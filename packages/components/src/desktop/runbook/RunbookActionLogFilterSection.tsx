import { previewRunbookLogFilter } from "@bitsentry-ce/core";

import type { RunbookActionRecord } from "../../services";
import type { TranslationFn } from "./types";

type RunbookActionLogFilterSectionProps = {
  action: RunbookActionRecord;
  logFilterErrors: string[];
  logFilterPreview: ReturnType<typeof previewRunbookLogFilter>;
  logFilterSample: string;
  logFilterToggleText: string;
  onActionChange: (action: RunbookActionRecord) => void;
  onLogFilterSampleChange: (value: string) => void;
  t: TranslationFn;
};

export function RunbookActionLogFilterSection({
  action,
  logFilterErrors,
  logFilterPreview,
  logFilterSample,
  logFilterToggleText,
  onActionChange,
  onLogFilterSampleChange,
  t,
}: RunbookActionLogFilterSectionProps) {
  const logFilter = action.logFilter;

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("runbooks.runbook.logFilter")}
          </label>
          <p className="mt-1 text-xs text-muted-foreground/60">
            {t("runbooks.runbook.extractNamedRegexGroupsInto")}{" "}
            {t("runbooks.runbook.stepsNStructuredoutputKey")}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            let nextLogFilter: typeof logFilter | undefined;
            if (logFilter === undefined) {
              nextLogFilter = {
                pattern: "",
                match: "first" as const,
              };
            }

            onActionChange({
              ...action,
              logFilter: nextLogFilter,
            });
          }}
          className="text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {logFilterToggleText}
        </button>
      </div>

      {logFilter === undefined && (
        <p className="rounded-lg border border-dashed border-border bg-background/50 px-3 py-2 text-xs text-muted-foreground/60">
          {t("runbooks.runbook.noLogFilterConfiguredStep")}
        </p>
      )}
      {logFilter !== undefined && (
        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
              {t("runbooks.runbook.pattern")}
            </label>
            <input
              value={logFilter.pattern}
              onChange={(event) => {
                onActionChange({
                  ...action,
                  logFilter: {
                    ...logFilter,
                    pattern: event.target.value,
                  },
                });
              }}
              placeholder={t("runbooks.runbook.activeActiveConnectionsD")}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
            />
            <p className="mt-1.5 text-xs text-muted-foreground/60">
              {t("runbooks.runbook.useAtLeastOneNamed")}{" "}
              <code>{t("runbooks.runbook.ltTraceIdGt")}</code>.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
                {t("runbooks.runbook.matchMode")}
              </label>
              <select
                value={logFilter.match ?? "first"}
                onChange={(event) => {
                  let match: "all" | "first" = "first";
                  let maxMatches: number | undefined;
                  if (event.target.value === "all") {
                    match = "all";
                    maxMatches = logFilter.maxMatches;
                  }

                  onActionChange({
                    ...action,
                    logFilter: {
                      ...logFilter,
                      match,
                      maxMatches,
                    },
                  });
                }}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
              >
                <option value="first">{t("runbooks.runbook.firstMatch")}</option>
                <option value="all">{t("runbooks.runbook.allMatches")}</option>
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
                {t("runbooks.runbook.flags")}
              </label>
              <input
                value={logFilter.flags ?? ""}
                onChange={(event) => {
                  let flags: string | undefined = event.target.value;
                  if (flags.length === 0) {
                    flags = undefined;
                  }

                  onActionChange({
                    ...action,
                    logFilter: {
                      ...logFilter,
                      flags,
                    },
                  });
                }}
                placeholder={t("runbooks.runbook.optionalISU")}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={logFilter.multiline === true}
                onChange={(event) => {
                  onActionChange({
                    ...action,
                    logFilter: {
                      ...logFilter,
                      multiline: event.target.checked,
                    },
                  });
                }}
                className="size-3 rounded border-border"
              />
              {t("runbooks.runbook.multilineMode")}
            </label>
            {(logFilter.match ?? "first") === "all" && (
              <div>
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
                  {t("runbooks.runbook.maxMatches")}
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={logFilter.maxMatches ?? ""}
                  onChange={(event) => {
                    let maxMatches: number | undefined;
                    if (event.target.value.length > 0) {
                      maxMatches = Number(event.target.value);
                    }

                    onActionChange({
                      ...action,
                      logFilter: {
                        ...logFilter,
                        maxMatches,
                      },
                    });
                  }}
                  placeholder={t("runbooks.runbook.default20")}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
                />
              </div>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
              {t("runbooks.runbook.sampleOutputPreview")}
            </label>
            <textarea
              value={logFilterSample}
              onChange={(event) => {
                onLogFilterSampleChange(event.target.value);
              }}
              placeholder={t("runbooks.runbook.pasteExampleStepOutputHere")}
              rows={6}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
            />
          </div>

          {logFilterErrors.length > 0 && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {logFilterErrors.join(" ")}
            </div>
          )}

          {logFilterSample.length > 0 && (
            <div className="rounded-lg border border-border bg-background/70 px-3 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground/60">
                <span>{t("runbooks.runbook.preview")}</span>
                {typeof logFilterPreview.matchCount === "number" && (
                  <LogFilterMatchCount matchCount={logFilterPreview.matchCount} />
                )}
                {logFilterPreview.groupNames !== undefined &&
                  logFilterPreview.groupNames.length > 0 && (
                    <>
                      <span className="text-muted-foreground/30">•</span>
                      <span>{logFilterPreview.groupNames.join(", ")}</span>
                    </>
                  )}
              </div>
              {logFilterPreview.error !== undefined &&
                logFilterPreview.error.length > 0 && (
                  <div className="mt-2 text-xs text-destructive">
                    {logFilterPreview.error}
                  </div>
                )}
              {logFilterPreview.error === undefined &&
                logFilterPreview.matched === false && (
                  <div className="mt-2 text-xs text-muted-foreground/60">
                    {t("runbooks.runbook.noValuesExtracted")}
                  </div>
                )}
              {logFilterPreview.error === undefined &&
                logFilterPreview.matched !== false && (
                  <div className="mt-3 overflow-hidden rounded-md border border-border">
                    <table className="min-w-full divide-y divide-border text-xs">
                      <tbody className="divide-y divide-border">
                        {Object.entries(
                          logFilterPreview.structuredOutput ?? {},
                        ).map(([key, value]) => {
                          let displayValue = JSON.stringify(value);
                          if (typeof value === "string") {
                            displayValue = value;
                          }

                          return (
                            <tr key={key}>
                              <td className="w-40 bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
                                {key}
                              </td>
                              <td className="px-3 py-2 font-mono text-xs text-foreground">
                                {displayValue}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LogFilterMatchCount({ matchCount }: { matchCount: number }) {
  let label = "matches";
  if (matchCount === 1) {
    label = "match";
  }

  return (
    <>
      <span className="text-muted-foreground/30">•</span>
      <span>
        {matchCount} {label}
      </span>
    </>
  );
}
