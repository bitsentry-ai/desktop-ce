import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRight, Loader2, Minus, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { Badge } from "../ui/badge";
import { ComposerQuestionCard, QuestionOption, QuestionPrimaryButton } from "./ComposerQuestionCard";

/** Success marks a finished fix and destructive a failed or rejected one; every other status is neutral. */
export type RemediationFlowTone = "neutral" | "success" | "destructive";

/** A short state shown on an option. A check badge, as a Wazuh check, has a dashed border to tell it apart. */
export interface RemediationFlowBadge {
  label: string;
  tone: RemediationFlowTone;
  check?: boolean;
}

export interface RemediationFlowOption {
  label: string;
  hint?: string;
  /** Shown below the other options with no number key, such as "New SSH connection". Keep it last. */
  pinned?: boolean;
  /** States shown at the end of the option, in order. */
  badges?: RemediationFlowBadge[];
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
  /** Compact shows one line for each option in a scroll box, for a list that can be long. */
  optionLayout?: "list" | "compact";
  /** How many saved items the options come from, shown next to the step in the compact layout. */
  count?: number;
  selected?: number;
  select: (index: number) => void;
  rows?: RemediationFlowRow[];
  /** Shown with a spinner while the fix runs. */
  running?: string;
  /** A neutral result, as a package that was already patched, changed nothing. */
  result?: { tone: RemediationFlowTone; title: string; detail?: string };
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

function OptionBadges({ badges }: { badges: RemediationFlowBadge[] | undefined }) {
  if (badges === undefined || badges.length === 0) return null;
  return (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      {badges.map((badge) => (
        <Badge
          key={badge.label}
          variant={badge.tone === "neutral" ? "secondary" : badge.tone}
          className={cn("whitespace-nowrap px-1.5 py-0 text-[10px] font-semibold", badge.check === true && "border-dashed border-foreground/25")}
        >
          {badge.label}
        </Badge>
      ))}
    </span>
  );
}

function isTextField(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** The options with a number key, in order, by their index in `flow.options`. */
function keyedOptions(flow: ComposerRemediationFlow): number[] {
  return flow.options.flatMap((option, index) => (option.pinned === true ? [] : [index]));
}

/** ArrowUp and ArrowDown move the pick through the options with a number key, in the compact layout. */
export function moveRemediationSelection(flow: ComposerRemediationFlow, key: string): boolean {
  if (flow.optionLayout !== "compact" || flow.submitting || (key !== "ArrowUp" && key !== "ArrowDown")) return false;
  const keyed = keyedOptions(flow);
  if (keyed.length === 0) return false;
  const at = flow.selected === undefined ? -1 : keyed.indexOf(flow.selected);
  let next = Math.min(keyed.length - 1, at + 1);
  if (key === "ArrowUp") next = at < 0 ? 0 : Math.max(0, at - 1);
  flow.select(keyed[next]);
  return true;
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
 * The options as one-line rows in a scroll box about four rows high, with pinned options below it. A fade at the
 * bottom shows while more rows are below, and the picked row scrolls into view.
 */
function CompactOptions({ flow, label }: { flow: ComposerRemediationFlow; label: string }) {
  const { t } = useTranslation();
  const scroll = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const keyed = keyedOptions(flow);
  const pinned = flow.options.flatMap((option, index) => (option.pinned === true ? [index] : []));
  const searching = flow.input !== undefined && flow.input.value.trim() !== "";

  useEffect(() => {
    const element = scroll.current;
    if (element === null) return;
    const check = () => { setMore(element.scrollHeight - element.scrollTop - element.clientHeight > 4); };
    check();
    element.addEventListener("scroll", check);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, [keyed.length]);

  const position = flow.selected === undefined ? -1 : keyed.indexOf(flow.selected);
  useEffect(() => {
    if (position < 0) return;
    scroll.current?.children[position]?.scrollIntoView({ block: "nearest" });
  }, [position]);

  const option = (index: number, keyIndex: number) => {
    const item = flow.options[index];
    return (
      <QuestionOption
        key={`${item.label}:${item.hint ?? ""}`}
        label={item.label}
        hint={item.hint}
        index={keyIndex}
        selected={flow.selected === index}
        disabled={flow.submitting}
        onSelect={() => { flow.select(index); }}
        compact
        pinned={item.pinned}
        trailing={<OptionBadges badges={item.badges} />}
      />
    );
  };
  return (
    <div role="group" aria-label={label} className="mt-2.5">
      {keyed.length === 0 && searching && <p className="px-3 py-2.5 text-[13px] text-muted-foreground">{t("common.incidents.remediation.noConnectionMatch")}</p>}
      {keyed.length > 0 && (
        <div className="relative">
          <div ref={scroll} className="grid max-h-[9.75rem] gap-1 overflow-y-auto pr-0.5 [scrollbar-color:theme(colors.violet.300)_transparent] [scrollbar-width:thin]">
            {keyed.map((index, keyIndex) => option(index, keyIndex))}
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-[34px] rounded-b-lg bg-gradient-to-b from-transparent to-violet-50 transition-opacity duration-150 dark:to-background",
              more ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
      )}
      {pinned.length > 0 && <div className="mt-1.5 grid gap-1">{pinned.map((index) => option(index, -1))}</div>}
    </div>
  );
}

/**
 * One CVE remediation step above the composer text, built from the customer report card's parts. Number keys pick an
 * option and Enter runs the primary button while focus is outside a text field; Escape closes the card.
 */
const RESULT_TONES: Record<RemediationFlowTone, string> = {
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400",
  destructive: "bg-destructive/10 text-destructive",
  neutral: "bg-muted text-muted-foreground",
};

function ResultIcon({ tone }: { tone: RemediationFlowTone }) {
  if (tone === "success") return <CheckIcon size={16} aria-hidden="true" />;
  if (tone === "neutral") return <Minus size={16} aria-hidden="true" />;
  return <X size={16} aria-hidden="true" />;
}

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
      if (moveRemediationSelection(current, event.key)) {
        event.preventDefault();
        return;
      }
      const keyed = keyedOptions(current);
      const digit = Number.parseInt(event.key, 10);
      if (Number.isNaN(digit) || digit < 1 || digit > Math.min(keyed.length, 9)) return;
      event.preventDefault();
      current.select(keyed[digit - 1]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, []);

  const title = t("common.incidents.remediation.title");
  const compact = flow.optionLayout === "compact";
  const keyed = keyedOptions(flow);
  const step = flow.step === undefined
    ? <StatusBadge status={flow.status} />
    : <span className="text-[11px] tabular-nums text-muted-foreground">{`${String(flow.step.index)}/${String(flow.step.total)}`}</span>;
  const aside = compact && flow.count !== undefined ? (
    <>
      {step}
      <Badge variant="secondary" className="shrink-0 whitespace-nowrap px-1.5 py-0 text-[10px] font-semibold">
        {t("common.incidents.remediation.savedCount", { count: flow.count })}
      </Badge>
    </>
  ) : step;
  return (
    <ComposerQuestionCard label={title} aside={aside} close={{ label: t("common.incidents.remediation.close"), run: flow.close }} divided={flow.input !== undefined}>
      {flow.question !== undefined && <p className="text-sm text-foreground/90">{flow.question}</p>}
      {flow.context.length > 0 && <ContextLine context={flow.context} />}
      {compact ? <CompactOptions flow={flow} label={flow.question ?? title} /> : flow.options.length > 0 && (
        <div role="group" aria-label={flow.question ?? title} className="mt-2.5 grid gap-1.5">
          {flow.options.map((option, index) => (
            <QuestionOption
              key={`${option.label}:${option.hint ?? ""}`}
              label={option.label}
              hint={option.hint}
              index={keyed.indexOf(index)}
              selected={flow.selected === index}
              disabled={flow.submitting}
              onSelect={() => { flow.select(index); }}
              pinned={option.pinned}
              trailing={<OptionBadges badges={option.badges} />}
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
              RESULT_TONES[flow.result.tone],
            )}
          >
            <ResultIcon tone={flow.result.tone} />
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
