import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@bitsentry-ce/i18n";
import {
  formatCustomerReportDismissMessage,
  type CustomerReportIntake,
  type CustomerReportIntakeAnswer,
  type CustomerReportIntakeField,
  type EditableIntakeField,
} from "@bitsentry-ce/core/features/plugins";
import {
  browserTimeZone,
  CHANGE_SOMETHING,
  customerReportAnswerMessage,
  intakeAnswerText,
  intakeQuestionView,
  nowInTimeZone,
  parseReceivedTime,
  TYPE_INSTEAD,
  type CustomerReportIntakeClient,
  type IntakeQuestionKey,
  type IntakeQuestionView,
} from "./customerReport";

/** What the composer needs to show the open customer report question. */
export interface ComposerCustomerReportIntake {
  question: IntakeQuestionView;
  /** True while the engineer changes an earlier answer: Submit reads Update, and closing only cancels the change. */
  editing: boolean;
  selected: number | undefined;
  select: (index: number) => void;
  answerText: string;
  setAnswerText: (text: string) => void;
  error: string | null;
  submitting: boolean;
  canSubmit: boolean;
  submit: () => void;
  dismiss: () => void;
}

/** What chat bubbles need: the intake, and whether its answers can be changed now. */
export interface CustomerReportIntakeChat {
  intake: CustomerReportIntake | null;
  canEdit: boolean;
  edit: (field: EditableIntakeField) => void;
  chooseEdit: () => void;
}

export const CustomerReportIntakeChatContext = createContext<CustomerReportIntakeChat | null>(null);
export function useCustomerReportIntakeChat(): CustomerReportIntakeChat | null {
  return useContext(CustomerReportIntakeChatContext);
}

type Mode = { kind: "asked" } | { kind: "edit"; field: EditableIntakeField } | { kind: "choose" };
type Translate = (key: string, values?: Record<string, unknown>) => string;
const K = "common.incidents.customerReport";

const NO = /^(no|nope|tidak|bukan|nggak|enggak|ga|gak|non|否|不是)\b/i;

/** The answer for what the engineer typed or picked, or the message that says why it cannot be used. */
function resolveAnswer(t: Translate, field: CustomerReportIntakeField, view: IntakeQuestionView, typed: string, selected: number | undefined, timeZone: string): { answer: CustomerReportIntakeAnswer } | { error: string } | null {
  if (typed.trim() !== "" && field !== "confirm") {
    switch (field) {
      case "origin": return { answer: { field, value: !NO.test(typed.trim()) } };
      case "channel": {
        const match = view.options.find((option) => option.label.toLocaleLowerCase() === typed.trim().toLocaleLowerCase() || String(option.value) === typed.trim().toLowerCase());
        return { answer: { field, value: (match?.value ?? "other") as never } };
      }
      case "receivedAt": {
        const parsed = parseReceivedTime(typed, timeZone);
        if ("issue" in parsed) return { error: t(parsed.issue === "future" ? `${K}.errors.future` : `${K}.errors.timeFormat`) };
        return { answer: { field, value: parsed.iso, timeZone } };
      }
      case "reportText": return { answer: { field, value: typed } };
      default: return { answer: { field, value: typed.trim() } };
    }
  }
  const option = selected === undefined ? undefined : view.options[selected];
  if (option === undefined) return null;
  if (option.value === TYPE_INSTEAD) return { error: t(`${K}.errors.typeTime`) };
  if (field === "receivedAt") return { answer: { field, value: option.value as string | null, timeZone } };
  return { answer: { field, value: option.value } as CustomerReportIntakeAnswer };
}

function errorMessage(t: Translate, error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  const text = error instanceof Error ? error.message : "";
  if (code === "INTAKE_TIME_IN_FUTURE" || text.includes("INTAKE_TIME_IN_FUTURE")) return t(`${K}.errors.future`);
  if (code === "INTAKE_REPORT_IN_USE" || text.includes("INTAKE_REPORT_IN_USE")) return t(`${K}.errors.inUse`);
  return t(`${K}.errors.saveFailed`);
}

/** The value an earlier answer stands for, so changing it starts from what the engineer gave. */
function prefill(view: IntakeQuestionView, value: unknown, timeZone: string): { selected?: number; text?: string } {
  const index = view.options.findIndex((option) => JSON.stringify(option.value) === JSON.stringify(value) && option.value !== undefined);
  if (index >= 0) return { selected: index };
  if (typeof value !== "string") return {};
  return { text: view.key === "receivedAt" ? typedReceivedTime(value, timeZone) : value };
}

/** A saved received time as the engineer would type it: "09:30" today, "yesterday 14:10", else empty. */
function typedReceivedTime(iso: string, timeZone: string, now: Date = new Date()): string {
  const local = nowInTimeZone(timeZone, new Date(iso));
  const today = nowInTimeZone(timeZone, now).slice(0, 10);
  const yesterday = nowInTimeZone(timeZone, new Date(now.getTime() - 24 * 60 * 60_000)).slice(0, 10);
  if (local.startsWith(today)) return local.slice(11);
  return local.startsWith(yesterday) ? `yesterday ${local.slice(11)}` : "";
}

/**
 * The conversation's customer report intake. The agent opens a question; the engineer answers in the composer panel;
 * each answer is saved, then sent to the agent as a chat message. The answered question stays, disabled, until the
 * agent's turn starts, and the next question opens only when that turn ends, so it always follows the agent's reply.
 */
export function useCustomerReportIntake({ client, threadId, busy, send }: {
  client: CustomerReportIntakeClient | undefined;
  threadId: string | null;
  /** True while the agent works; the panel waits until its reply is in. */
  busy: boolean;
  send: (text: string) => void | Promise<void>;
}): { composer: ComposerCustomerReportIntake | undefined; chat: CustomerReportIntakeChat } {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ threadId: string | null; intake: CustomerReportIntake | null }>({ threadId: null, intake: null });
  const [mode, setMode] = useState<Mode>({ kind: "asked" });
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [answerText, setAnswerText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const request = useRef<{ key: string; id: string } | null>(null);
  const intake = state.threadId === threadId ? state.intake : null;

  const load = useCallback(async () => {
    if (client === undefined || threadId === null) return;
    try {
      const latest = await client.latest(threadId);
      setState({ threadId, intake: latest });
    } catch {
      // The panel stays closed until the next load; chat itself keeps working.
    }
  }, [client, threadId]);

  useEffect(() => {
    setMode({ kind: "asked" });
    void load();
  }, [load]);
  // The agent opens questions during its turn; read the intake again once the turn ends.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
  }, [busy, load]);

  let key: IntakeQuestionKey | null = null;
  if (mode.kind === "edit") key = mode.field;
  else if (mode.kind === "choose") key = "fix";
  else if (intake?.status === "open") key = intake.question;
  const view = useMemo(() => (intake === null || key === null ? null : intakeQuestionView(t, key, intake, new Date(), i18n?.language)), [intake, key, t, i18n?.language]);

  // A new question starts empty; changing an answer starts from the current value.
  const viewKey = `${intake?.id ?? ""}:${mode.kind}:${key ?? ""}`;
  useEffect(() => {
    setError(null);
    request.current = null;
    if (mode.kind === "edit" && view !== null && intake !== null) {
      const start = prefill(view, intake.answers[mode.field], intake.timeZone);
      setSelected(start.selected);
      setAnswerText(start.text ?? "");
    } else {
      setSelected(undefined);
      setAnswerText("");
    }
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitAnswer = useCallback(async (index: number | undefined, typed: string) => {
    if (client === undefined || intake === null || view === null || threadId === null || submitting) return;
    if (view.key === "fix") {
      const choice = index === undefined ? undefined : view.options[index];
      if (choice !== undefined) setMode({ kind: "edit", field: choice.value as EditableIntakeField });
      return;
    }
    if (view.key === "confirm" && index !== undefined && view.options[index]?.value === CHANGE_SOMETHING) {
      setMode({ kind: "choose" });
      return;
    }
    // Typed and "just now" times are read on the engineer's own clock.
    const resolved = resolveAnswer(t, view.key, view, typed, index, browserTimeZone());
    if (resolved === null) return;
    if ("error" in resolved) { setError(resolved.error); return; }
    const editing = mode.kind === "edit";
    const requestKey = JSON.stringify(resolved.answer);
    if (request.current?.key !== requestKey) request.current = { key: requestKey, id: crypto.randomUUID() };
    setSubmitting(true);
    setError(null);
    try {
      const result = await client.answer({ threadId, intakeId: intake.id, clientRequestId: request.current.id, answer: resolved.answer });
      request.current = null;
      const shown = intakeAnswerText(t, resolved.answer.field, resolved.answer.value, intake.timeZone, i18n?.language);
      try {
        // The answered question stays until the agent's turn starts; the next one opens when that turn ends.
        await send(customerReportAnswerMessage(result, resolved.answer.field, shown, editing));
      } finally {
        setState({ threadId, intake: result.intake });
        setMode({ kind: "asked" });
      }
    } catch (cause) {
      setError(errorMessage(t, cause));
    } finally {
      setSubmitting(false);
    }
  }, [client, i18n?.language, intake, mode.kind, send, submitting, t, threadId, view]);

  const dismiss = useCallback(async () => {
    if (mode.kind !== "asked") { setMode({ kind: "asked" }); return; }
    if (client === undefined || intake === null || threadId === null || submitting) return;
    setSubmitting(true);
    try {
      const closed = await client.dismiss({ threadId, intakeId: intake.id });
      try {
        // A closed correction keeps the saved report; only a new report that is closed tells the agent.
        if (closed.status === "dismissed") await send(formatCustomerReportDismissMessage(closed.id));
      } finally {
        setState({ threadId, intake: closed });
      }
    } catch (cause) {
      setError(errorMessage(t, cause));
    } finally {
      setSubmitting(false);
    }
  }, [client, intake, mode.kind, send, submitting, t, threadId]);

  const select = useCallback((index: number) => {
    setSelected(index);
    setAnswerText("");
    setError(null);
    const option = view?.options[index];
    // A picked option is the answer, as in T3 Code; "type the time" waits for the typed time.
    if (option !== undefined && option.value !== TYPE_INSTEAD) void submitAnswer(index, "");
  }, [submitAnswer, view]);

  const canEdit = client !== undefined && intake !== null && intake.status !== "dismissed" && !busy && !submitting;
  const chat = useMemo<CustomerReportIntakeChat>(() => ({
    intake,
    canEdit,
    edit: (field) => { if (canEdit) setMode({ kind: "edit", field }); },
    chooseEdit: () => { if (canEdit) setMode({ kind: "choose" }); },
  }), [canEdit, intake]);

  const option = selected === undefined ? undefined : view?.options[selected];
  const composer = view === null || busy || client === undefined ? undefined : {
    question: view,
    editing: mode.kind !== "asked",
    selected,
    select,
    answerText,
    setAnswerText: (text: string) => { setAnswerText(text); setError(null); if (text.trim() !== "") setSelected(undefined); },
    error,
    submitting,
    canSubmit: !submitting && (answerText.trim() !== "" || (option !== undefined && option.value !== TYPE_INSTEAD)),
    submit: () => { void submitAnswer(answerText.trim() === "" ? selected : undefined, answerText); },
    dismiss: () => { void dismiss(); },
  };
  return { composer, chat };
}
