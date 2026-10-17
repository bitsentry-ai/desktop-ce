import { z } from "zod";
import {
  customerReportChannels,
  customerReportInputSchema,
  isIanaTimeZone,
  isoWithOffsetSchema,
  type CustomerReportInput,
} from "./customer-reports";

/**
 * A customer report collected in Incident chat, one question at a time. The agent starts it when the engineer relays
 * what a customer said or sent; the engineer answers in the composer panel. Values the chat already gives are not asked
 * again, and nothing is guessed: an unknown sender or time stays empty.
 */

/** The questions, in the order they are asked. `origin` is asked only when the agent is not sure the message is from a customer. */
export const customerReportIntakeFields = ["origin", "channel", "sender", "subject", "receivedAt", "reportText"] as const;
export type CustomerReportIntakeField = (typeof customerReportIntakeFields)[number];

/** Fields the agent may fill from the conversation. The report text always comes from the engineer. */
export const extractableIntakeFields = ["channel", "sender", "subject", "receivedAt"] as const;
export type ExtractableIntakeField = (typeof extractableIntakeFields)[number];

/** Answers the engineer can change after giving them. */
export const editableIntakeFields = ["channel", "sender", "subject", "receivedAt", "reportText"] as const;
export type EditableIntakeField = (typeof editableIntakeFields)[number];

const senderSchema = z.string().trim().min(1).max(200);
const subjectSchema = z.string().trim().min(1).max(300);
const reportTextSchema = z.string().min(1).max(30_000).refine((value) => value.trim().length > 0);

export const customerReportIntakeAnswersSchema = z.object({
  channel: z.enum(customerReportChannels).optional(),
  sender: senderSchema.nullable().optional(),
  subject: subjectSchema.nullable().optional(),
  receivedAt: isoWithOffsetSchema.nullable().optional(),
  reportText: reportTextSchema.optional(),
}).strict();
export type CustomerReportIntakeAnswers = z.infer<typeof customerReportIntakeAnswersSchema>;

export const customerReportIntakeStatuses = ["open", "dismissed", "saved"] as const;
export type CustomerReportIntakeStatus = (typeof customerReportIntakeStatuses)[number];

export const customerReportIntakeSchema = z.object({
  id: z.uuid(),
  threadId: z.string().min(1).max(200),
  status: z.enum(customerReportIntakeStatuses),
  /** The question the panel shows now, or null when none is open. */
  question: z.enum(customerReportIntakeFields).nullable(),
  /** True while the agent still needs the engineer to confirm the message is from a customer. */
  needsOrigin: z.boolean(),
  /** The engineer's message that started the intake; offered as "Use what I wrote". */
  relayedText: z.string().max(30_000),
  timeZone: z.string().min(1).max(64).refine(isIanaTimeZone),
  answers: customerReportIntakeAnswersSchema,
  /** The saved report, once the intake is complete; a correction moves it to the new version. */
  customerReportId: z.uuid().nullable(),
  /** The last answer request applied, so a retried submit does not apply twice. */
  lastRequestId: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type CustomerReportIntake = z.infer<typeof customerReportIntakeSchema>;

/** One value the agent read from the conversation, with the exact words it came from. */
export const intakeExtractionSchema = z.object({
  field: z.enum(extractableIntakeFields),
  value: z.string().min(1).max(300),
  quote: z.string().min(2).max(500),
}).strict();
export type IntakeExtraction = z.infer<typeof intakeExtractionSchema>;

/** What the engineer answers in the panel. Null means "Not sure". */
export const customerReportIntakeAnswerSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("origin"), value: z.boolean() }).strict(),
  z.object({ field: z.literal("channel"), value: z.enum(customerReportChannels) }).strict(),
  z.object({ field: z.literal("sender"), value: senderSchema.nullable() }).strict(),
  z.object({ field: z.literal("subject"), value: subjectSchema }).strict(),
  z.object({ field: z.literal("receivedAt"), value: isoWithOffsetSchema.nullable() }).strict(),
  z.object({ field: z.literal("reportText"), value: reportTextSchema }).strict(),
]);
export type CustomerReportIntakeAnswer = z.infer<typeof customerReportIntakeAnswerSchema>;

export const customerReportIntakeAnswerInputSchema = z.object({
  threadId: z.string().min(1).max(200),
  intakeId: z.uuid(),
  clientRequestId: z.uuid(),
  answer: customerReportIntakeAnswerSchema,
}).strict();
export type CustomerReportIntakeAnswerInput = z.infer<typeof customerReportIntakeAnswerInputSchema>;

export const customerReportIntakeDismissInputSchema = z.object({
  threadId: z.string().min(1).max(200),
  intakeId: z.uuid(),
}).strict();
export type CustomerReportIntakeDismissInput = z.infer<typeof customerReportIntakeDismissInputSchema>;

/** What the agent passes when it starts an intake. */
export const customerReportIntakeStartSchema = z.object({
  origin: z.enum(["customer", "unsure"]),
  newReport: z.boolean().optional(),
  extracted: z.array(intakeExtractionSchema).max(8).optional(),
}).strict();
export type CustomerReportIntakeStart = z.infer<typeof customerReportIntakeStartSchema>;

/** A store that keeps intakes per conversation. `latest` is the newest one, whatever its status. */
export interface CustomerReportIntakeStore {
  latest(threadId: string): Promise<CustomerReportIntake | null>;
  get(threadId: string, id: string): Promise<CustomerReportIntake | null>;
  save(intake: CustomerReportIntake): Promise<CustomerReportIntake>;
}

export class CustomerReportIntakeError extends Error {
  constructor(readonly code: "INTAKE_NOT_FOUND" | "INTAKE_CLOSED" | "INTAKE_FIELD_NOT_ASKED" | "INTAKE_TIME_IN_FUTURE" | "INTAKE_REPORT_IN_USE", message: string) {
    super(message);
    this.name = "CustomerReportIntakeError";
  }
}

/** The next question for these answers, or null when the report can be saved. Subject is asked for email only. */
export function nextIntakeQuestion(intake: Pick<CustomerReportIntake, "needsOrigin" | "answers">): CustomerReportIntakeField | null {
  if (intake.needsOrigin) return "origin";
  const { answers } = intake;
  if (answers.channel === undefined) return "channel";
  if (answers.sender === undefined) return "sender";
  if (answers.channel === "email" && answers.subject === undefined) return "subject";
  if (answers.receivedAt === undefined) return "receivedAt";
  if (answers.reportText === undefined) return "reportText";
  return null;
}

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** A received time may be a few minutes ahead of the server's clock, but not later than that. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const inFuture = (iso: string, now: Date) => Date.parse(iso) > now.getTime() + FUTURE_TOLERANCE_MS;

/**
 * The extracted values that are grounded in the conversation. A value is kept only if its quote appears in what the
 * engineer wrote; a sender or subject must also appear inside its quote. Anything else is dropped, so it is asked.
 */
export function groundedExtractions(extracted: readonly IntakeExtraction[], conversation: readonly string[], now: Date = new Date()): Partial<Record<ExtractableIntakeField, string>> {
  const text = normalize(conversation.join("\n"));
  const kept: Partial<Record<ExtractableIntakeField, string>> = {};
  for (const item of extracted) {
    const quote = normalize(item.quote);
    if (quote.length < 2 || !text.includes(quote) || kept[item.field] !== undefined) continue;
    const value = item.value.trim();
    if (item.field === "channel") {
      if ((customerReportChannels as readonly string[]).includes(value)) kept.channel = value;
    } else if (item.field === "receivedAt") {
      if (isoWithOffsetSchema.safeParse(value).success && !inFuture(value, now)) kept.receivedAt = value;
    } else if (value.length > 0 && quote.includes(normalize(value))) {
      kept[item.field] = value;
    }
  }
  return kept;
}

function withExtractions(answers: CustomerReportIntakeAnswers, grounded: Partial<Record<ExtractableIntakeField, string>>): CustomerReportIntakeAnswers {
  const next = { ...answers };
  if (next.channel === undefined && grounded.channel !== undefined) next.channel = grounded.channel as CustomerReportIntakeAnswers["channel"];
  if (next.sender === undefined && grounded.sender !== undefined) next.sender = grounded.sender;
  if (next.subject === undefined && grounded.subject !== undefined) next.subject = grounded.subject;
  if (next.receivedAt === undefined && grounded.receivedAt !== undefined) next.receivedAt = grounded.receivedAt;
  if (next.channel !== undefined && next.channel !== "email") delete next.subject;
  return customerReportIntakeAnswersSchema.parse(next);
}

const sameCustomer = (left: string | null | undefined, right: string | undefined) =>
  right === undefined || (left !== undefined && left !== null && normalize(left) === normalize(right));

export type CustomerReportIntakeStartResult =
  | { kind: "asking"; intake: CustomerReportIntake }
  | { kind: "closed"; intake: CustomerReportIntake };

/**
 * Starts an intake, or continues the open one. A dismissed or saved intake stays closed: only a report from a different,
 * named customer starts a new one.
 */
export function startCustomerReportIntake(previous: CustomerReportIntake | null, request: {
  id: string;
  threadId: string;
  timeZone: string;
  start: CustomerReportIntakeStart;
  conversation: readonly string[];
  relayedText: string;
  now?: Date;
}): CustomerReportIntakeStartResult {
  const now = request.now ?? new Date();
  const grounded = groundedExtractions(request.start.extracted ?? [], request.conversation, now);
  const stamp = now.toISOString();
  if (previous?.status === "open") {
    const answers = withExtractions(previous.answers, grounded);
    const intake = { ...previous, answers, updatedAt: stamp };
    return { kind: "asking", intake: { ...intake, question: nextIntakeQuestion(intake) } };
  }
  if (previous !== null && (request.start.newReport !== true || sameCustomer(previous.answers.sender, grounded.sender))) {
    return { kind: "closed", intake: previous };
  }
  const draft = {
    id: request.id, threadId: request.threadId, status: "open" as const,
    needsOrigin: request.start.origin === "unsure",
    relayedText: request.relayedText.slice(0, 30_000),
    timeZone: isIanaTimeZone(request.timeZone) ? request.timeZone : "UTC",
    answers: withExtractions({}, grounded),
    customerReportId: null, lastRequestId: null, createdAt: stamp, updatedAt: stamp,
  };
  return { kind: "asking", intake: customerReportIntakeSchema.parse({ ...draft, question: nextIntakeQuestion(draft) }) };
}

export type CustomerReportIntakeAnswerResult =
  /** Nothing changed: the same request was applied before. */
  | { kind: "unchanged"; intake: CustomerReportIntake }
  | { kind: "asking"; intake: CustomerReportIntake }
  | { kind: "dismissed"; intake: CustomerReportIntake }
  /** Every field is known; the caller saves this report and then calls `markIntakeSaved`. */
  | { kind: "complete"; intake: CustomerReportIntake; report: Omit<CustomerReportInput, "threadId" | "clientRequestId"> }
  /** A saved report was corrected; the caller saves the new version, marks the old one superseded, then `markIntakeSaved`. */
  | { kind: "corrected"; intake: CustomerReportIntake; report: Omit<CustomerReportInput, "threadId" | "clientRequestId">; replaces: string };

function reportFrom(intake: CustomerReportIntake): Omit<CustomerReportInput, "threadId" | "clientRequestId"> {
  const { answers } = intake;
  return customerReportInputSchema.omit({ threadId: true, clientRequestId: true }).parse({
    channel: answers.channel,
    sender: answers.sender ?? null,
    receivedAt: answers.receivedAt ?? null,
    timeZone: intake.timeZone,
    ...(answers.channel === "email" && answers.subject !== undefined ? { subject: answers.subject } : {}),
    reportText: answers.reportText,
    intakeId: intake.id,
  });
}

/**
 * Applies one answer. While the intake is open the answer may be the open question or a change to an earlier answer;
 * after it is saved, only a change to an earlier answer, which produces a corrected report.
 */
export function answerCustomerReportIntake(intake: CustomerReportIntake, input: { clientRequestId: string; answer: CustomerReportIntakeAnswer }, now: Date = new Date()): CustomerReportIntakeAnswerResult {
  if (intake.lastRequestId === input.clientRequestId) return { kind: "unchanged", intake };
  if (intake.status === "dismissed") throw new CustomerReportIntakeError("INTAKE_CLOSED", "This customer report was dismissed.");
  const { answer } = input;
  const answered = answer.field !== "origin" && intake.answers[answer.field] !== undefined;
  if (answer.field !== intake.question && !answered) {
    throw new CustomerReportIntakeError("INTAKE_FIELD_NOT_ASKED", `The ${answer.field} question is not open.`);
  }
  if (answer.field === "receivedAt" && answer.value !== null && inFuture(answer.value, now)) {
    throw new CustomerReportIntakeError("INTAKE_TIME_IN_FUTURE", "The received time cannot be in the future.");
  }
  const stamp = now.toISOString();
  const base = { ...intake, lastRequestId: input.clientRequestId, updatedAt: stamp };
  if (answer.field === "origin") {
    if (!answer.value) return { kind: "dismissed", intake: { ...base, status: "dismissed", question: null } };
    return settle({ ...base, needsOrigin: false, answers: { ...base.answers, reportText: base.answers.reportText ?? intake.relayedText } });
  }
  const answers: CustomerReportIntakeAnswers = { ...base.answers, [answer.field]: answer.value };
  if (answers.channel !== "email") delete answers.subject;
  return settle({ ...base, answers: customerReportIntakeAnswersSchema.parse(answers) });
}

function settle(next: CustomerReportIntake): CustomerReportIntakeAnswerResult {
  const question = nextIntakeQuestion(next);
  if (question !== null) return { kind: "asking", intake: customerReportIntakeSchema.parse({ ...next, status: "open", question }) };
  const intake = customerReportIntakeSchema.parse({ ...next, question: null });
  if (intake.customerReportId !== null) return { kind: "corrected", intake, report: reportFrom(intake), replaces: intake.customerReportId };
  return { kind: "complete", intake, report: reportFrom(intake) };
}

/** Records the report saved for a complete or corrected intake. */
export function markIntakeSaved(intake: CustomerReportIntake, customerReportId: string): CustomerReportIntake {
  return customerReportIntakeSchema.parse({ ...intake, status: "saved", question: null, customerReportId });
}

/** The answers a saved report stands for, used to undo a correction the engineer did not finish. */
export function answersFromReport(report: Pick<CustomerReportInput, "channel" | "sender" | "subject" | "receivedAt" | "reportText">): CustomerReportIntakeAnswers {
  return customerReportIntakeAnswersSchema.parse({
    channel: report.channel, sender: report.sender, receivedAt: report.receivedAt, reportText: report.reportText,
    ...(report.channel === "email" && report.subject !== undefined ? { subject: report.subject } : {}),
  });
}

/**
 * Closes an open intake for good. When the intake already has a saved report, an open question belongs to an
 * unfinished correction: closing it keeps the saved report and its answers, given as `saved`.
 */
export function dismissCustomerReportIntake(intake: CustomerReportIntake, saved: Pick<CustomerReportInput, "channel" | "sender" | "subject" | "receivedAt" | "reportText"> | null, now: Date = new Date()): CustomerReportIntake {
  if (intake.status !== "open") return intake;
  const updatedAt = now.toISOString();
  if (intake.customerReportId !== null && saved !== null) return { ...intake, status: "saved", question: null, answers: answersFromReport(saved), updatedAt };
  return { ...intake, status: "dismissed", question: null, updatedAt };
}

/**
 * Answers and dismissals reach the agent as chat messages with one header line, like `[customer-report]`, so the
 * conversation shows them and the agent knows what changed.
 */
const ANSWER_PREFIX = "[customer-report-answer]";
const DISMISS_PREFIX = "[customer-report-dismissed]";

const answerHeaderSchema = z.object({
  intakeId: z.uuid(),
  field: z.enum(customerReportIntakeFields),
  /** The answer as the engineer saw it, e.g. "Not sure" or "Email". */
  answer: z.string().max(300),
  /** True when the engineer changed an earlier answer. */
  edit: z.boolean().optional(),
  /** The question asked next, or null when the report is complete. */
  next: z.enum(customerReportIntakeFields).nullable(),
  /** The report saved by this answer, for a complete or corrected intake. */
  customerReportId: z.uuid().optional(),
}).strict();
export type CustomerReportAnswerHeader = z.infer<typeof answerHeaderSchema>;

const dismissHeaderSchema = z.object({ intakeId: z.uuid() }).strict();

/** The body carries the saved report as a `[customer-report]` message when this answer completed or corrected it. */
export function formatCustomerReportAnswerMessage(header: CustomerReportAnswerHeader, body = ""): string {
  const line = `${ANSWER_PREFIX}${JSON.stringify(answerHeaderSchema.parse(header))}`;
  return body === "" ? line : `${line}\n${body}`;
}

export function formatCustomerReportDismissMessage(intakeId: string): string {
  return `${DISMISS_PREFIX}${JSON.stringify(dismissHeaderSchema.parse({ intakeId }))}`;
}

function parseHeader<T>(text: string, prefix: string, schema: z.ZodType<T>): { header: T; body: string } | null {
  if (!text.startsWith(prefix)) return null;
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  try {
    const header = schema.safeParse(JSON.parse(line.slice(prefix.length)));
    return header.success ? { header: header.data, body: end === -1 ? "" : text.slice(end + 1) } : null;
  } catch {
    return null;
  }
}

export function parseCustomerReportAnswerMessage(text: string): { header: CustomerReportAnswerHeader; body: string } | null {
  return parseHeader(text, ANSWER_PREFIX, answerHeaderSchema);
}

export function parseCustomerReportDismissMessage(text: string): { header: { intakeId: string }; body: string } | null {
  return parseHeader(text, DISMISS_PREFIX, dismissHeaderSchema);
}
