import { useEffect, useRef } from "react";
import { CheckIcon, ChevronRight, Loader2, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { ComposerQuestionCard, QuestionOption, QuestionPrimaryButton } from "./ComposerQuestionCard";

/** Success marks a finished fix and destructive a failed or rejected one; every other status is neutral. */
export type RemediationFlowTone = "neutral" | "success" | "destructive";

export interface RemediationFlowOption {
  label: string;
  hint?: string;
}

export interface RemediationFlowRow {
  label: string;
  value: string;
  detail?: string;
  /** Opens the step that sets this value. */
  edit?: () => void;
}

export interface RemediationFlowButton {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
}

/** What the composer needs to show one CVE remediation step. The host owns the steps; the card only shows them. */
export interface ComposerRemediationFlow {
  /** False after the engineer closes the card; the resume chip then shows above the composer. */
  open: boolean;
  close: () => void;
  resume: () => void;
  status: { tone: RemediationFlowTone; label: string };
  /** The finding this step is about, CVE id first. */
  context: string[];
  /** The position in the steps that collect input. Other steps show the status instead. */
  step?: { index: number; total: number };
  question?: string;
  options: RemediationFlowOption[];
  selected?: number;
  select: (index: number) => void;
  rows?: RemediationFlowRow[];
  /** Shown with a spinner while the fix runs. */
  running?: string;
  result?: { tone: Exclude<RemediationFlowTone, "neutral">; title: string; detail?: string };
  notice?: string;
  details?: { label: string; text: string }[];
  error?: string | null;
  /** The text area holds this value. Steps without it hide the text area. */
  input?: { value: string; placeholder: string; onChange: (value: string) => void };
  back?: () => void;
  secondary?: RemediationFlowButton;
  primary?: RemediationFlowButton;
  submitting: boolean;
}

function StatusBadge({ status }: { status: ComposerRemediationFlow["status"] }) {
  return (
    <Badge variant={status.tone === "neutral" ? "secondary" : status.tone} className="shrink-0 whitespace-nowrap px-1.5 py-0 text-[10px] font-semibold">
      {status.label}
    </Badge>
  );
}

function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** Shown above the composer while the remediation card is closed. */
export function RemediationResumeChip({ flow, disabled }: { flow: ComposerRemediationFlow; disabled: boolean }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={flow.resume}
      disabled={disabled}
      className="mb-2 ml-0.5 inline-flex max-w-full items-center gap-2 rounded-full border border-violet-200 bg-violet-50 py-1 pl-2.5 pr-3 text-xs transition-colors duration-150 animate-in fade-in hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-violet-500/30 dark:bg-violet-500/10 dark:hover:bg-violet-500/15"
    >
      <span className="font-semibold text-foreground">{t("common.incidents.remediation.title")}</span>
      <StatusBadge status={flow.status} />
      <span className="inline-flex items-center gap-0.5 font-semibold text-violet-700 dark:text-violet-300">
        {t("common.incidents.remediation.resume")}
        <ChevronRight size={12} aria-hidden="true" />
      </span>
    </button>
  );
}

const QUIET_BUTTON = "h-8 whitespace-nowrap rounded-[10px] px-3 text-[13px] font-medium transition-colors disabled:opacity-50";

/** The step's buttons, in place of the send button. */
export function RemediationFlowButtons({ flow }: { flow: ComposerRemediationFlow }) {
  const { t } = useTranslation();
  const { primary, secondary } = flow;
  return (
    <div className="flex items-center gap-1.5">
      {flow.back !== undefined && (
        <button type="button" onClick={flow.back} disabled={flow.submitting} className={cn(QUIET_BUTTON, "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          {t("common.incidents.remediation.back")}
        </button>
      )}
      {secondary !== undefined && (
        <button
          type="button"
          onClick={secondary.run}
          disabled={flow.submitting || secondary.disabled === true}
          className={cn(QUIET_BUTTON, "border border-border bg-background hover:bg-accent")}
        >
          {secondary.label}
        </button>
      )}
      {primary !== undefined && (
        <QuestionPrimaryButton
          label={primary.label}
          run={primary.run}
          disabled={flow.submitting || primary.disabled === true}
          submitting={flow.submitting}
          danger={primary.danger}
        />
      )}
    </div>
  );
}

/** The finding as one muted line: the CVE id, then the package change and the agent. */
function ContextLine({ context }: { context: string[] }) {
  const [cveId, ...rest] = context;
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      <span className="font-mono font-semibold text-foreground">{cveId}</span>
      {rest.map((item) => ` · ${item}`).join("")}
    </p>
  );
}

/**
 * One CVE remediation step above the composer text, built from the customer report card's parts. Number keys pick an
 * option and Enter runs the primary button while focus is outside a text field; Escape closes the card.
 */
export function RemediationQuestionPanel({ flow }: { flow: ComposerRemediationFlow }) {
  const { t } = useTranslation();
  const latest = useRef(flow);
  latest.current = flow;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      // A dialog over the page, such as the new SSH connection form, keeps its own keys.
      if (target instanceof Element && target.closest('[role="dialog"]') !== null) return;
      const current = latest.current;
      if (event.key === "Escape") {
        event.preventDefault();
        current.close();
        return;
      }
      if (isTextField(target) || current.submitting) return;
      if (event.key === "Enter") {
        // A focused button other than an option runs itself.
        if (target instanceof HTMLButtonElement && !target.hasAttribute("aria-pressed")) return;
        if (current.primary === undefined || current.primary.disabled === true) return;
        event.preventDefault();
        current.primary.run();
        return;
      }
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > Math.min(current.options.length, 9)) return;
      event.preventDefault();
      current.select(digit - 1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, []);

  const title = t("common.incidents.remediation.title");
  const step = flow.step === undefined
    ? <StatusBadge status={flow.status} />
    : <span className="text-[11px] tabular-nums text-muted-foreground">{`${String(flow.step.index)}/${String(flow.step.total)}`}</span>;
  return (
    <ComposerQuestionCard label={title} aside={step} close={{ label: t("common.incidents.remediation.close"), run: flow.close }} divided={flow.input !== undefined}>
      {flow.question !== undefined && <p className="text-sm text-foreground/90">{flow.question}</p>}
      {flow.context.length > 0 && <ContextLine context={flow.context} />}
      {flow.options.length > 0 && (
        <div role="group" aria-label={flow.question ?? title} className="mt-2.5 grid gap-1.5">
          {flow.options.map((option, index) => (
            <QuestionOption
              key={`${option.label}:${option.hint ?? ""}`}
              label={option.label}
              hint={option.hint}
              index={index}
              selected={flow.selected === index}
              disabled={flow.submitting}
              onSelect={() => { flow.select(index); }}
            />
          ))}
        </div>
      )}
      {flow.rows !== undefined && flow.rows.length > 0 && (
        <dl className="mt-2.5 overflow-hidden rounded-lg border border-border bg-muted/40 text-sm">
          {flow.rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate">
                {row.value}
                {row.detail !== undefined && <span className="ml-1.5 text-xs text-muted-foreground">{row.detail}</span>}
              </dd>
              {row.edit !== undefined ? (
                <button
                  type="button"
                  onClick={row.edit}
                  disabled={flow.submitting}
                  aria-label={`${t("common.incidents.remediation.edit")} ${row.label}`}
                  className="text-xs font-medium text-violet-700 hover:underline disabled:opacity-50 dark:text-violet-300"
                >
                  {t("common.incidents.remediation.edit")}
                </button>
              ) : <span />}
            </div>
          ))}
        </dl>
      )}
      {flow.running !== undefined && (
        <p role="status" className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <Loader2 size={14} className="animate-spin text-violet-600 dark:text-violet-300" aria-hidden="true" />
          {flow.running}
        </p>
      )}
      {flow.result !== undefined && (
        <div className="mt-2 flex items-center gap-3">
          <span
            className={cn(
              "flex size-[30px] shrink-0 items-center justify-center rounded-full",
              flow.result.tone === "success" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400" : "bg-destructive/10 text-destructive",
            )}
          >
            {flow.result.tone === "success" ? <CheckIcon size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{flow.result.title}</p>
            {flow.result.detail !== undefined && <p className="truncate text-xs text-muted-foreground">{flow.result.detail}</p>}
          </div>
        </div>
      )}
      {flow.notice !== undefined && <p className="mt-2 text-xs text-muted-foreground">{flow.notice}</p>}
      {flow.details?.map((detail) => (
        <details key={detail.label} className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{detail.label}</summary>
          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-muted-foreground">{detail.text}</pre>
        </details>
      ))}
      {flow.error !== undefined && flow.error !== null && <p role="alert" className="mt-2 whitespace-pre-line text-xs text-destructive">{flow.error}</p>}
    </ComposerQuestionCard>
  );
}
