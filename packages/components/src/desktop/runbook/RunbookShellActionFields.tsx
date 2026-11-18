import type { RunbookActionTypeFieldsProps } from "./RunbookActionFieldShared";

type RunbookShellActionFieldsProps = Pick<
  RunbookActionTypeFieldsProps,
  "action" | "actionMeta" | "onActionChange" | "t"
>;

export function RunbookShellActionFields({
  action,
  actionMeta,
  onActionChange,
  t,
}: RunbookShellActionFieldsProps) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted-foreground/60">
        {t(actionMeta.shell.fieldLabelKey)}
      </label>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-1.5 bg-muted/40 px-3 py-1">
          <span className="size-1.5 rounded-full bg-muted-foreground/20" />
          <span className="size-1.5 rounded-full bg-muted-foreground/20" />
          <span className="size-1.5 rounded-full bg-muted-foreground/20" />
        </div>
        <textarea
          value={action.command ?? ""}
          onChange={(event) => {
            onActionChange({
              ...action,
              command: event.target.value,
            });
          }}
          rows={4}
          placeholder={t(actionMeta.shell.fieldPlaceholderKey)}
          className="w-full resize-none bg-muted/20 px-3 py-2 font-mono text-xs leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/40"
        />
      </div>
    </div>
  );
}
