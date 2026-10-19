import { useEffect } from "react";
import { Lock } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { Badge } from "../ui/badge";
import { ComposerQuestionCard, QuestionOption } from "./ComposerQuestionCard";
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
    <ComposerQuestionCard
      label={t("common.incidents.customerReport.title")}
      close={{
        label: t(intake.editing ? "common.incidents.customerReport.cancelChange" : "common.incidents.customerReport.dismiss"),
        run: intake.dismiss,
        disabled: submitting,
      }}
    >
      <p className="text-sm text-foreground/90">{question.title}</p>
      {question.options.length > 0 && (
        <div role="group" aria-label={question.title} className="mt-2.5 grid gap-1.5">
          {question.options.map((option, index) => (
            <QuestionOption
              key={`${question.key}:${option.label}`}
              label={option.label}
              hint={option.hint}
              index={index}
              selected={selected === index && !typed}
              disabled={submitting}
              onSelect={() => { select(index); }}
            />
          ))}
        </div>
      )}
      {error !== null && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </ComposerQuestionCard>
  );
}
