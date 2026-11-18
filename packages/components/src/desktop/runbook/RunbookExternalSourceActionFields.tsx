import { cn } from "../../lib/utils";
import {
  MISSING_SOURCE_SELECT_VALUE,
  type RunbookActionTypeFieldsProps,
} from "./RunbookActionFieldShared";

type RunbookExternalSourceActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  | "action"
  | "actionMeta"
  | "errorSourceOptions"
  | "errorSourcesLoading"
  | "isMissingErrorSource"
  | "sourceHelpClass"
  | "sourceHelpText"
  | "sourcePlaceholderText"
  | "sourceSelectClass"
  | "sourceSelectValue"
  | "onActionChange"
  | "t"
>;

export function RunbookExternalSourceActionFields({
  action,
  actionMeta,
  errorSourceOptions,
  errorSourcesLoading,
  isMissingErrorSource,
  sourceHelpClass,
  sourceHelpText,
  sourcePlaceholderText,
  sourceSelectClass,
  sourceSelectValue,
  onActionChange,
  t,
}: RunbookExternalSourceActionFieldsProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.externalSource")}
        </label>
        <select
          data-tour="data-sources-runbook-selector"
          value={sourceSelectValue}
          onChange={(event) => {
            const selectedSourceId = event.target.value;
            let sourceId: string | undefined;
            if (
              selectedSourceId.length > 0 &&
              selectedSourceId !== MISSING_SOURCE_SELECT_VALUE
            ) {
              sourceId = selectedSourceId;
            }
            onActionChange({
              ...action,
              sourceId,
            });
          }}
          disabled={errorSourcesLoading || errorSourceOptions.length === 0}
          className={cn(
            "w-full rounded-lg border bg-background px-3 py-2 text-xs outline-none transition-colors",
            sourceSelectClass,
          )}
        >
          <option value="" disabled>
            {sourcePlaceholderText}
          </option>
          {isMissingErrorSource && (
            <option value={MISSING_SOURCE_SELECT_VALUE}>
              {t("runbooks.runbook.missingSource")}
              {action.sourceId?.slice(0, 8)})
            </option>
          )}
          {errorSourceOptions.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
        <p className={cn("mt-1.5 text-xs", sourceHelpClass)}>
          {sourceHelpText}
        </p>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
          {t(actionMeta.external_source.fieldLabelKey)}
        </label>
        <input
          data-tour="data-sources-runbook-query"
          value={action.query ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              query: event.target.value,
            });
          }}
          placeholder={t(actionMeta.external_source.fieldPlaceholderKey)}
          className="w-full rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
        />
      </div>
    </div>
  );
}
