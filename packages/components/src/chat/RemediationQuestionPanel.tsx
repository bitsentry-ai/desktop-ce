import { useEffect, useRef } from "react";
import {
  CheckIcon,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock,
  Globe,
  Loader2,
  Play,
  Plus,
  Server,
  ShieldAlert,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";

export type RemediationFlowTone = "need" | "wait" | "run" | "ok" | "bad";
export type RemediationFlowIcon = "finding" | "server" | "plus" | "host" | "approve" | "reject" | "run" | "later";

export interface RemediationFlowOption {
  label: string;
  hint?: string;
  icon?: RemediationFlowIcon;
  danger?: boolean;
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
  /** True when nothing is left to do: the chip then reads View instead of Resume. */
  finished: boolean;
  /** Candidate and action counts for the chip. */
  summary: string;
  /** The finding this step is about. */
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
  result?: { tone: "ok" | "bad"; title: string; detail?: string };
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

const ICONS: Record<RemediationFlowIcon, LucideIcon> = {
  finding: ShieldAlert,
  server: Server,
  plus: Plus,
  host: Globe,
  approve: CircleCheck,
  reject: CircleX,
  run: Play,
  later: Clock,
};

const TONES: Record<RemediationFlowTone, string> = {
  need: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
  wait: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300",
  run: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
  bad: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
};

function StatusPill({ status }: { status: ComposerRemediationFlow["status"] }) {
  return (
    <span className={cn("whitespace-nowrap rounded-full border px-2 py-px text-[11px] font-medium", TONES[status.tone])}>
      {status.label}
    </span>
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
      className="mb-2 ml-0.5 inline-flex max-w-full items-center gap-2 rounded-full border border-amber-200 bg-amber-50 py-1 pl-2.5 pr-3 text-xs transition-colors duration-150 animate-in fade-in hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15"
    >
      <ShieldCheck size={14} className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="font-semibold text-foreground">{t("common.incidents.remediation.title")}</span>
      <span className="hidden truncate text-muted-foreground sm:inline">{flow.summary}</span>
      <StatusPill status={flow.status} />
      <span className="inline-flex items-center gap-0.5 font-semibold text-amber-600 dark:text-amber-400">
        {t(flow.finished ? "common.incidents.remediation.view" : "common.incidents.remediation.resume")}
        <ChevronRight size={12} aria-hidden="true" />
      </span>
    </button>
  );
}

/** The step's buttons, in place of the send button. */
export function RemediationFlowButtons({ flow }: { flow: ComposerRemediationFlow }) {
  const { t } = useTranslation();
  const { primary, secondary } = flow;
  return (
    <div className="flex items-center gap-1.5">
      {flow.back !== undefined && (
        <button
          type="button"
          onClick={flow.back}
          disabled={flow.submitting}
          className="h-8 rounded-[10px] px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {t("common.incidents.remediation.back")}
        </button>
      )}
      {secondary !== undefined && (
        <button
          type="button"
          onClick={secondary.run}
          disabled={flow.submitting || secondary.disabled === true}
          className="h-8 whitespace-nowrap rounded-[10px] border border-border bg-background px-3 text-[13px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
        >
          {secondary.label}
        </button>
      )}
      {primary !== undefined && (
        <button
          type="button"
          onClick={primary.run}
          disabled={flow.submitting || primary.disabled === true}
          className={cn(
            "h-8 whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-semibold text-white transition-colors disabled:cursor-default",
            primary.danger === true
              ? "bg-red-600 hover:bg-red-700 disabled:bg-red-200 dark:disabled:bg-red-500/30"
              : "bg-amber-600 hover:bg-amber-700 disabled:bg-amber-200 dark:disabled:bg-amber-500/30",
          )}
        >
          {flow.submitting ? <Loader2 size={14} className="animate-spin" aria-label={primary.label} /> : primary.label}
        </button>
      )}
    </div>
  );
}

/**
 * One CVE remediation step above the composer text, in the style of the customer report question. Number keys pick an
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
        if (target instanceof HTMLButtonElement && !target.hasAttribute("data-remediation-option")) return;
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
  return (
    <section
      aria-label={title}
      className="rounded-t-[19px] border-b border-amber-200 bg-gradient-to-b from-amber-50 to-amber-50/40 px-4 py-3 duration-200 animate-in fade-in slide-in-from-bottom-1 dark:border-amber-500/30 dark:from-amber-500/10 dark:to-transparent"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-300">
          <ShieldCheck size={13} aria-hidden="true" />
          {title}
        </span>
        {flow.step !== undefined ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">{`${String(flow.step.index)}/${String(flow.step.total)}`}</span>
        ) : (
          <StatusPill status={flow.status} />
        )}
        <button
          type="button"
          onClick={flow.close}
          aria-label={t("common.incidents.remediation.close")}
          className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-amber-100 hover:text-amber-800 dark:hover:bg-amber-500/15 dark:hover:text-amber-200"
        >
          <X size={14} />
        </button>
      </div>
      {flow.context.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {flow.context.map((item, index) => (
            <span
              key={item}
              className={cn(
                "rounded-md border border-amber-200 bg-background px-1.5 py-px text-xs dark:border-amber-500/30",
                index === 0 ? "font-mono font-semibold text-foreground" : "text-amber-900 dark:text-amber-200",
              )}
            >
              {item}
            </span>
          ))}
        </div>
      )}
      {flow.question !== undefined && <p className="text-sm text-foreground/90">{flow.question}</p>}
      {flow.options.length > 0 && (
        <div role="group" aria-label={flow.question ?? title} className="mt-2.5 grid gap-1.5">
          {flow.options.map((option, index) => {
            const on = flow.selected === index;
            const Icon = ICONS[option.icon ?? "server"];
            return (
              <button
                key={`${option.label}:${option.hint ?? ""}`}
                type="button"
                data-remediation-option=""
                aria-pressed={on}
                disabled={flow.submitting}
                onClick={() => { flow.select(index); }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:border-amber-400 focus-visible:ring-2 focus-visible:ring-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60",
                  on ? "border-amber-400 bg-background shadow-[inset_0_0_0_1px] shadow-amber-500 dark:bg-amber-500/10" : "border-transparent bg-background/70 hover:border-amber-200 hover:bg-background",
                )}
              >
                <span className="flex size-[26px] shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                  <Icon size={14} aria-hidden="true" className={cn(option.danger === true && "text-red-600", option.icon === "approve" && "text-emerald-600")} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn("text-sm font-medium", option.danger === true ? "text-red-600 dark:text-red-400" : "text-foreground")}>{option.label}</span>
                  {option.hint !== undefined && <span className="truncate font-mono text-xs text-muted-foreground">{option.hint}</span>}
                </span>
                {on ? (
                  <CheckIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
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
      {flow.rows !== undefined && flow.rows.length > 0 && (
        <dl className="mt-2.5 overflow-hidden rounded-lg border border-amber-200 bg-background text-sm dark:border-amber-500/30">
          {flow.rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2 border-b border-amber-100 px-3 py-1.5 last:border-b-0 dark:border-amber-500/15">
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate">
                {row.value}
                {row.detail !== undefined && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{row.detail}</span>}
              </dd>
              {row.edit !== undefined ? (
                <button
                  type="button"
                  onClick={row.edit}
                  disabled={flow.submitting}
                  aria-label={`${t("common.incidents.remediation.edit")} ${row.label}`}
                  className="text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 dark:text-amber-300"
                >
                  {t("common.incidents.remediation.edit")}
                </button>
              ) : <span />}
            </div>
          ))}
        </dl>
      )}
      {flow.running !== undefined && (
        <p role="status" className="mt-2.5 flex items-center gap-2 rounded-lg border border-amber-200 bg-background px-3 py-2 text-sm dark:border-amber-500/30">
          <Loader2 size={14} className="animate-spin text-amber-600" aria-hidden="true" />
          {flow.running}
        </p>
      )}
      {flow.result !== undefined && (
        <div className="mt-1 flex items-center gap-3">
          <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-full", flow.result.tone === "ok" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10" : "bg-red-50 text-red-600 dark:bg-red-500/10")}>
            {flow.result.tone === "ok" ? <CheckIcon size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{flow.result.title}</p>
            {flow.result.detail !== undefined && <p className="truncate font-mono text-xs text-muted-foreground">{flow.result.detail}</p>}
          </div>
        </div>
      )}
      {flow.notice !== undefined && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{flow.notice}</p>}
      {flow.details?.map((detail) => (
        <details key={detail.label} className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">{detail.label}</summary>
          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-muted-foreground">{detail.text}</pre>
        </details>
      ))}
      {flow.error !== undefined && flow.error !== null && <p role="alert" className="mt-2 whitespace-pre-line text-xs text-destructive">{flow.error}</p>}
    </section>
  );
}
