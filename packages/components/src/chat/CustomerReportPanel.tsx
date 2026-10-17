import { useEffect } from "react";
import { CheckIcon, Lock, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import type { ComposerCustomerReportIntake } from "./useCustomerReportIntake";

/** The shared "internal only" marker for a customer report: in the chat card and the approval card. */
export function CustomerReportInternalBadge({ label }: { label: string }) {
  return (
    <Badge variant="secondary" className="shrink-0 gap-1 whitespace-nowrap px-1.5 py-0 text-[10px] font-semibold">
      <Lock size={10} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/**
 * One customer report question above the composer text, in the style of T3 Code's pending user input: options to pick,
 * or a typed answer in the composer. Number keys pick an option while focus is outside a text field.
 */
export function CustomerReportQuestionPanel({ intake }: { intake: ComposerCustomerReportIntake }) {
  const { t } = useTranslation();
  const { question, selected, select, submitting, error } = intake;
  const typed = intake.answerText.trim() !== "";

  useEffect(() => {
    if (question.options.length === 0 || submitting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])') !== null) return;
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > question.options.length) return;
      event.preventDefault();
      select(digit - 1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [question.options.length, select, submitting]);

  return (
    <section
      aria-label={t("common.incidents.customerReport.title")}
      className="rounded-t-[19px] border-b border-violet-200 bg-gradient-to-b from-violet-50 to-violet-50/30 px-4 py-3 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:border-violet-500/30 dark:from-violet-500/10 dark:to-transparent"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-violet-700 dark:text-violet-300">
          {t("common.incidents.customerReport.title")}
        </span>
        <button
          type="button"
          onClick={intake.dismiss}
          disabled={submitting}
          aria-label={t(intake.editing ? "common.incidents.customerReport.cancelChange" : "common.incidents.customerReport.dismiss")}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-violet-100 hover:text-violet-800 disabled:opacity-50 dark:hover:bg-violet-500/15 dark:hover:text-violet-200"
        >
          <X size={14} />
        </button>
      </div>
      <p className="text-sm text-foreground/90">{question.title}</p>
      {question.options.length > 0 && (
        <div role="group" aria-label={question.title} className="mt-2.5 grid gap-1.5">
          {question.options.map((option, index) => {
            const on = selected === index && !typed;
            return (
              <button
                key={`${question.key}:${option.label}`}
                type="button"
                aria-pressed={on}
                disabled={submitting}
                onClick={() => { select(index); }}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-violet-400 focus-visible:ring-2 focus-visible:ring-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60",
                  on ? "border-violet-300 bg-violet-100/70 dark:border-violet-400/40 dark:bg-violet-500/15" : "border-transparent bg-muted/60 hover:bg-muted",
                )}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium text-foreground">{option.label}</span>
                  {option.hint !== undefined && <span className="truncate text-xs text-muted-foreground">{option.hint}</span>}
                </span>
                {on ? (
                  <CheckIcon className="size-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                ) : index < 9 ? (
                  <kbd className="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-background text-[11px] font-medium tabular-nums text-muted-foreground">
                    {index + 1}
                  </kbd>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {error !== null && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}
