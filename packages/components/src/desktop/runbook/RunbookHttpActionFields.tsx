import type {
  RunbookHttpHeader,
  RunbookHttpMethod,
} from "../../services";
import {
  createEmptyHttpHeader,
  type RunbookActionTypeFieldsProps,
} from "./RunbookActionFieldShared";

type RunbookHttpActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  | "action"
  | "actionMeta"
  | "headers"
  | "httpMethods"
  | "httpBodyPlaceholder"
  | "httpBodyValue"
  | "isGetHttpMethod"
  | "onActionChange"
  | "t"
>;

export function RunbookHttpActionFields({
  action,
  actionMeta,
  headers,
  httpMethods,
  httpBodyPlaceholder,
  httpBodyValue,
  isGetHttpMethod,
  onActionChange,
  t,
}: RunbookHttpActionFieldsProps) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select
          value={action.method ?? "GET"}
          onChange={(event) => {
            const method = event.target.value as RunbookHttpMethod;
            let body = action.body;
            if (method === "GET") {
              body = undefined;
            }

            onActionChange({
              ...action,
              method,
              body,
            });
          }}
          className="rounded-lg border border-border bg-background px-2 py-2 text-xs outline-none"
        >
          {httpMethods.map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <input
          value={action.url ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              url: event.target.value,
            });
          }}
          placeholder={t(actionMeta.http.fieldPlaceholderKey)}
          className="flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50"
        />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("runbooks.runbook.headers")}
          </label>
          <button
            type="button"
            onClick={() => {
              onActionChange({
                ...action,
                headers: [...(action.headers ?? []), createEmptyHttpHeader()],
              });
            }}
            className="text-xs uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          >
            {t("runbooks.runbook.addHeader")}
          </button>
        </div>
        <div className="space-y-2">
          {headers.length === 0 && (
            <p className="rounded-lg border border-dashed border-border bg-muted/10 px-3 py-2 text-xs text-muted-foreground/60">
              {t("runbooks.runbook.noHeadersConfigured")}
            </p>
          )}
          {headers.length > 0 &&
            headers.map((header, headerIndex) => (
              <RunbookHttpHeaderRow
                key={`${action.id}:header:${String(headerIndex)}`}
                action={action}
                header={header}
                headerIndex={headerIndex}
                headers={headers}
                onActionChange={onActionChange}
                t={t}
              />
            ))}
        </div>
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
          {t("runbooks.runbook.body")}
        </label>
        <textarea
          value={httpBodyValue}
          onChange={(event) => {
            onActionChange({
              ...action,
              body: event.target.value,
            });
          }}
          rows={4}
          disabled={isGetHttpMethod}
          placeholder={httpBodyPlaceholder}
          className="w-full resize-none rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>
    </div>
  );
}

type RunbookHttpHeaderRowProps = Pick<
  RunbookActionTypeFieldsProps,
  "action" | "onActionChange" | "t"
> & {
  header: RunbookHttpHeader;
  headerIndex: number;
  headers: RunbookHttpHeader[];
};

function RunbookHttpHeaderRow({
  action,
  header,
  headerIndex,
  headers,
  onActionChange,
  t,
}: RunbookHttpHeaderRowProps) {
  return (
    <div className="flex gap-2">
      <input
        value={header.key}
        onChange={(event) => {
          const nextHeaders = [...(action.headers ?? [])];
          nextHeaders[headerIndex] = {
            ...header,
            key: event.target.value,
          };
          onActionChange({
            ...action,
            headers: nextHeaders,
          });
        }}
        placeholder={t("runbooks.runbook.headerName")}
        className="w-1/3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
      />
      <input
        value={header.value}
        onChange={(event) => {
          const nextHeaders = [...(action.headers ?? [])];
          nextHeaders[headerIndex] = {
            ...header,
            value: event.target.value,
          };
          onActionChange({
            ...action,
            headers: nextHeaders,
          });
        }}
        placeholder={t("runbooks.runbook.headerValue")}
        className="flex-1 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs outline-none transition-colors focus:border-primary/50"
      />
      <button
        type="button"
        onClick={() => {
          const nextHeaders = headers.filter(
            (_item, index) => index !== headerIndex,
          );
          let updatedHeaders: RunbookHttpHeader[] | undefined;
          if (nextHeaders.length > 0) {
            updatedHeaders = nextHeaders;
          }
          onActionChange({
            ...action,
            headers: updatedHeaders,
          });
        }}
        className="rounded-lg border border-border px-2 py-2 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
      >
        {t("common.actions.remove")}
      </button>
    </div>
  );
}
