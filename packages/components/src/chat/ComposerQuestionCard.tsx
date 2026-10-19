import type { ReactNode } from "react";
import { CheckIcon, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils";

// The line divides the card from the text area. Without a text area the toolbar follows, so the tint fades out instead.
const CARD_DIVIDED = "rounded-t-[19px] border-b border-violet-200 bg-gradient-to-b from-violet-50 to-violet-50/30 px-4 py-3 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:border-violet-500/30 dark:from-violet-500/10 dark:to-transparent";
const CARD_OPEN = "rounded-t-[19px] bg-gradient-to-b from-violet-50 to-transparent px-4 py-3 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:from-violet-500/10 dark:to-transparent";

const PRIMARY = "h-8 whitespace-nowrap rounded-[10px] bg-violet-600 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-violet-700 disabled:cursor-default disabled:bg-violet-200 dark:disabled:bg-violet-500/30";
const PRIMARY_DANGER = "h-8 whitespace-nowrap rounded-[10px] bg-destructive px-3.5 text-[13px] font-semibold text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:cursor-default disabled:bg-destructive/30";

/** The card above the composer text that asks the engineer one question, as the customer report and CVE remediation do. */
export function ComposerQuestionCard({ label, aside, close, divided = true, children }: {
  label: string;
  /** Shown after the label, such as a status badge. */
  aside?: ReactNode;
  close: { label: string; run: () => void; disabled?: boolean };
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={divided ? CARD_DIVIDED : CARD_OPEN}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-violet-700 dark:text-violet-300">{label}</span>
        {aside}
        <button
          type="button"
          onClick={close.run}
          disabled={close.disabled}
          aria-label={close.label}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-violet-100 hover:text-violet-800 disabled:opacity-50 dark:hover:bg-violet-500/15 dark:hover:text-violet-200"
        >
          <X size={14} />
        </button>
      </div>
      {children}
    </section>
  );
}

const OPTION = "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const OPTION_COMPACT = "group flex h-9 w-full shrink-0 items-center gap-3 rounded-lg border px-3 text-left outline-none transition-colors duration-150 focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60";
const OPTION_SELECTED = "border-violet-300 bg-violet-100/70 dark:border-violet-400/40 dark:bg-violet-500/15";
const OPTION_PINNED = "border-dashed border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10";

/**
 * One answer to pick: its number key shows until it is picked, then a check. A compact option is one line, with the
 * hint after the label. A pinned option, such as "New SSH connection", has a dashed border and no number key.
 */
export function QuestionOption({ label, hint, index, selected, disabled, onSelect, compact = false, pinned = false }: {
  label: string;
  hint?: string;
  index: number;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  compact?: boolean;
  pinned?: boolean;
}) {
  let tone = "border-transparent bg-muted/60 hover:bg-muted";
  if (selected) tone = OPTION_SELECTED;
  else if (pinned) tone = OPTION_PINNED;
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(compact ? OPTION_COMPACT : OPTION, tone)}
    >
      {compact ? (
        <span className="flex min-w-0 flex-1 items-baseline gap-3">
          <span className={cn("whitespace-nowrap text-sm font-medium", !pinned && "text-foreground")}>{label}</span>
          {hint !== undefined && <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{hint}</span>}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint !== undefined && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      )}
      {selected ? (
        <CheckIcon className="size-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
      ) : !pinned && index < 9 ? (
        <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[11px] font-medium tabular-nums text-muted-foreground">
          {index + 1}
        </kbd>
      ) : null}
    </button>
  );
}

/** The button that sends the answer, in place of the send button. A danger button asks to reject or delete. */
export function QuestionPrimaryButton({ label, run, disabled, submitting, danger = false }: {
  label: string;
  run: () => void;
  disabled: boolean;
  submitting: boolean;
  danger?: boolean;
}) {
  return (
    <button type="button" onClick={run} disabled={disabled} className={danger ? PRIMARY_DANGER : PRIMARY}>
      {submitting ? <Loader2 size={14} className="animate-spin" aria-label={label} /> : label}
    </button>
  );
}
