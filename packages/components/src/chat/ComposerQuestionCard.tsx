import type { ReactNode } from "react";
import { CheckIcon, Loader2, Plus, X } from "lucide-react";
import { cn } from "../lib/utils";

// The line divides the card from the text area. Without a text area the toolbar follows, so the tint fades out instead.
const CARD_DIVIDED = "rounded-t-[19px] border-b border-primary/25 bg-gradient-to-b from-primary/5 to-primary/[0.015] px-4 pb-2.5 pt-2.5 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:border-primary/30 dark:from-primary/10 dark:to-transparent";
const CARD_OPEN = "rounded-t-[19px] bg-gradient-to-b from-primary/5 to-transparent px-4 pb-2.5 pt-2.5 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:from-primary/10 dark:to-transparent";

const PRIMARY = "h-8 whitespace-nowrap rounded-[10px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:bg-primary/30 dark:disabled:bg-primary/30";
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
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-primary">{label}</span>
        {aside}
        <button
          type="button"
          onClick={close.run}
          disabled={close.disabled}
          aria-label={close.label}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground disabled:opacity-50 dark:hover:bg-primary/15 dark:hover:text-primary"
        >
          <X size={14} />
        </button>
      </div>
      {children}
    </section>
  );
}

const OPTION = "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const OPTION_COMPACT = "group flex h-8 w-full shrink-0 items-center gap-3 rounded-md border px-2.5 text-left outline-none transition-colors duration-150 focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
/** A compact row reads as a list line: no fill until hovered or picked. */
const OPTION_COMPACT_IDLE = "border-transparent hover:bg-muted/70";
/** A compact pinned option, such as "New SSH connection", is a quiet add row under the list. */
const OPTION_COMPACT_PINNED = "border-transparent text-primary hover:bg-primary/5 dark:hover:bg-primary/10";
const OPTION_SELECTED = "border-primary/40 bg-primary/10 dark:border-primary/40 dark:bg-primary/15";
const OPTION_PINNED = "border-dashed border-primary/40 text-primary hover:bg-primary/5 dark:border-primary/40 dark:text-primary dark:hover:bg-primary/10";

/**
 * One answer to pick: its number key shows until it is picked, then a check. A compact option is one line, with the
 * hint after the label. A pinned option, such as "New SSH connection", has a dashed border and no number key.
 */
export function QuestionOption({ label, hint, index, selected, disabled, onSelect, compact = false, pinned = false, trailing }: {
  label: string;
  hint?: string;
  index: number;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  compact?: boolean;
  pinned?: boolean;
  /** Shown before the number key, as the states of a listed item. */
  trailing?: ReactNode;
}) {
  let tone = compact ? OPTION_COMPACT_IDLE : "border-transparent bg-muted/60 hover:bg-muted";
  if (selected) tone = OPTION_SELECTED;
  else if (pinned) tone = compact ? OPTION_COMPACT_PINNED : OPTION_PINNED;
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
          {pinned && <Plus size={14} aria-hidden="true" className="shrink-0 self-center" />}
          <span className={cn("whitespace-nowrap text-sm font-medium", !pinned && "text-foreground")}>{label}</span>
          {hint !== undefined && <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{hint}</span>}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {hint !== undefined && <span className="truncate text-xs text-muted-foreground">{hint}</span>}
        </span>
      )}
      {trailing}
      <OptionShortcut selected={selected} pinned={pinned} index={index} subtle={compact} />
    </button>
  );
}

function OptionShortcut({ selected, pinned, index, subtle }: { selected: boolean; pinned: boolean; index: number; subtle: boolean }) {
  if (selected) return <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />;
  if (pinned || index >= 9) return null;
  return (
    <kbd
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-[11px] font-medium tabular-nums text-muted-foreground",
        subtle ? "text-muted-foreground/70 group-hover:text-muted-foreground" : "border border-border bg-background",
      )}
    >
      {index + 1}
    </kbd>
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
