import {
  customerReportChannels,
  editableIntakeFields,
  formatCustomerReportAnswerMessage,
  formatCustomerReportMessage,
  isIanaTimeZone,
  zonedLocalToIso,
  type CustomerReport,
  type CustomerReportIntake,
  type CustomerReportIntakeAnswerInput,
  type CustomerReportIntakeDismissInput,
  type CustomerReportIntakeField,
  type CustomerReportIntakeResult,
} from "@bitsentry-ce/core/features/plugins";

/** How a host reads and answers the conversation's customer report intake: IPC on Desktop, tRPC on the Dashboard. */
export interface CustomerReportIntakeClient {
  latest(threadId: string): Promise<CustomerReportIntake | null>;
  answer(input: CustomerReportIntakeAnswerInput): Promise<CustomerReportIntakeResult>;
  dismiss(input: CustomerReportIntakeDismissInput): Promise<CustomerReportIntake>;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The current wall-clock time in a time zone, as `YYYY-MM-DDTHH:mm`. */
export function nowInTimeZone(timeZone: string, now: Date = new Date()): string {
  const zone = isIanaTimeZone(timeZone) ? timeZone : "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** A received time may be a few minutes ahead of this device's clock, but not later than that. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Reads a typed received time in the report's zone: "09:30", "9.30", "today 09:30" or "yesterday 14:10"
 * (also "hari ini" and "kemarin"). Anything else is a format issue, so nothing is guessed.
 */
export function parseReceivedTime(text: string, timeZone: string, now: Date = new Date()): { iso: string } | { issue: "format" | "future" } {
  const match = /^(?:(yesterday|today|kemarin|hari ini)\s+)?(\d{1,2})[:.](\d{2})$/i.exec(text.trim());
  if (match === null) return { issue: "format" };
  const [hour, minute] = [Number(match[2]), Number(match[3])];
  if (hour > 23 || minute > 59) return { issue: "format" };
  const yesterday = /^(yesterday|kemarin)$/i.test(match[1] ?? "");
  const day = nowInTimeZone(timeZone, yesterday ? new Date(now.getTime() - DAY_MS) : now).slice(0, 10);
  const iso = zonedLocalToIso(`${day}T${pad(hour)}:${pad(minute)}`, timeZone);
  if (iso === null) return { issue: "format" };
  return Date.parse(iso) > now.getTime() + FUTURE_TOLERANCE_MS ? { issue: "future" } : { iso };
}

/** The current time in the zone, as ISO with that zone's offset. */
export function receivedNow(timeZone: string, now: Date = new Date()): string | null {
  return zonedLocalToIso(nowInTimeZone(timeZone, now), timeZone);
}

/** The panel's question, or `fix` while the engineer chooses which answer to change. */
export type IntakeQuestionKey = CustomerReportIntakeField | "fix";
/** An option's answer; `type` asks the engineer to type it instead. */
export interface IntakeOption { label: string; hint?: string; value: unknown }
export interface IntakeQuestionView {
  key: IntakeQuestionKey;
  title: string;
  placeholder?: string;
  multiline: boolean;
  options: IntakeOption[];
}

type Translate = (key: string, values?: Record<string, unknown>) => string;
const K = "common.incidents.customerReport";
export const TYPE_INSTEAD = "type";
/** The confirm option that opens "What should I change?" instead of saving. */
export const CHANGE_SOMETHING = "change";

export function intakeQuestionTitle(t: Translate, key: IntakeQuestionKey, channel?: string): string {
  if (key === "receivedAt" && channel === "phone") return t(`${K}.questions.receivedAtPhone`);
  if (key === "reportText" && channel === "phone") return t(`${K}.questions.reportTextPhone`);
  return t(`${K}.questions.${key}`);
}

function clock(iso: string, timeZone: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * What the panel shows for one question of this intake. `localZone` is the zone the engineer types times in, the
 * browser's own; times the intake already holds keep the zone they were given in.
 */
export function intakeQuestionView(t: Translate, key: IntakeQuestionKey, intake: CustomerReportIntake, now: Date = new Date(), locale?: string, localZone: string = browserTimeZone()): IntakeQuestionView {
  const { answers } = intake;
  const timeZone = localZone;
  const title = intakeQuestionTitle(t, key, answers.channel);
  const notSure = { label: t(`${K}.options.notSure`), value: null };
  switch (key) {
    case "origin":
      return { key, title, multiline: false, options: [{ label: t(`${K}.options.originYes`), value: true }, { label: t(`${K}.options.originNo`), value: false }] };
    case "channel":
      return { key, title, multiline: false, options: customerReportChannels.map((channel) => ({ label: t(`${K}.channels.${channel}`), value: channel })) };
    case "sender": {
      const contact = answers.channel === "email" ? "senderEmail" : answers.channel === "whatsapp" || answers.channel === "phone" ? "senderPhone" : "sender";
      return { key, title, placeholder: t(`${K}.placeholders.${contact}`), multiline: false, options: [notSure] };
    }
    case "subject":
      return { key, title, placeholder: t(`${K}.placeholders.subject`), multiline: false, options: [] };
    case "receivedAt": {
      const justNow = receivedNow(timeZone, now);
      return {
        key, title, placeholder: t(`${K}.placeholders.receivedAt`), multiline: false,
        options: [
          ...(justNow === null ? [] : [{ label: t(`${K}.options.justNow`), hint: clock(justNow, timeZone, locale), value: justNow }]),
          { label: t(`${K}.options.earlierToday`), hint: t(`${K}.options.earlierTodayHint`), value: TYPE_INSTEAD },
          notSure,
        ],
      };
    }
    case "reportText":
      return {
        key, title, placeholder: t(`${K}.placeholders.reportText`), multiline: true,
        options: intake.relayedText.trim() === "" ? [] : [{ label: t(`${K}.options.useWhatIWrote`), hint: shortText(intake.relayedText, 80), value: intake.relayedText }],
      };
    case "confirm": {
      const sender = answers.sender ?? t(`${K}.senderNotProvided`);
      const received = answers.receivedAt === undefined || answers.receivedAt === null ? t(`${K}.receivedNotProvided`) : formatReceivedAt(answers.receivedAt, intake.timeZone, locale);
      const summary = [answers.channel === undefined ? "" : t(`${K}.channels.${answers.channel}`), sender, received].filter((part) => part !== "").join(" · ");
      return {
        key, title, multiline: false,
        options: [{ label: t(`${K}.options.save`), hint: summary, value: true }, { label: t(`${K}.options.changeSomething`), value: CHANGE_SOMETHING }],
      };
    }
    case "fix":
      return {
        key, title, multiline: false,
        options: editableIntakeFields.filter((field) => field !== "subject" || answers.channel === "email").map((field) => ({ label: t(`${K}.fields.${field}`), value: field })),
      };
  }
}

export function shortText(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The answer as the timeline row and the agent see it. */
export function intakeAnswerText(t: Translate, field: CustomerReportIntakeField, value: unknown, timeZone: string, locale?: string): string {
  if (field === "origin") return t(value === true ? `${K}.options.originYes` : `${K}.options.originNo`);
  if (field === "confirm") return t(`${K}.options.save`);
  if (value === null) return t(`${K}.options.notSure`);
  if (field === "channel") return t(`${K}.channels.${String(value)}`);
  if (field === "receivedAt") return formatReceivedAt(String(value), timeZone, locale);
  return shortText(String(value), 200);
}

/** The zone's UTC offset at an instant, as `+08:00`. */
function zoneOffset(timeZone: string, instant: Date): string | null {
  const iso = zonedLocalToIso(nowInTimeZone(timeZone, instant), timeZone);
  return iso === null ? null : iso.slice(-6);
}

/**
 * A received time on the clock the engineer recorded: the same instant, the clock of its own offset, and the zone name
 * only when that zone has the same offset then. "10:15 (UTC+08:00)" is never shown as "02:15 (UTC, UTC+08:00)".
 */
export function formatReceivedAt(receivedAt: string, timeZone: string, locale?: string): string {
  const recorded = /(Z|[+-]\d{2}:\d{2})$/.exec(receivedAt)?.[1];
  const offset = recorded === undefined || recorded === "Z" ? "+00:00" : recorded;
  const instant = new Date(receivedAt);
  if (Number.isNaN(instant.getTime())) return receivedAt;
  try {
    if (isIanaTimeZone(timeZone) && zoneOffset(timeZone, instant) === offset) {
      const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(instant);
      return `${time} (${timeZone}, UTC${offset})`;
    }
    // No zone with this offset is known: show the recorded wall clock, read as UTC shifted by the offset.
    const sign = offset.startsWith("-") ? -1 : 1;
    const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
    const wall = new Date(instant.getTime() + minutes * 60_000);
    const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(wall);
    return `${time} (UTC${offset})`;
  } catch {
    return receivedAt;
  }
}

/** The chat message that carries one answer to the agent; a completing answer also carries the saved report. */
export function customerReportAnswerMessage(result: CustomerReportIntakeResult, field: CustomerReportIntakeField, answer: string, edit: boolean): string {
  const report: CustomerReport | null = result.report;
  return formatCustomerReportAnswerMessage({
    intakeId: result.intake.id,
    field,
    answer,
    ...(edit ? { edit: true } : {}),
    next: result.intake.status === "open" ? result.intake.question : null,
    ...(report === null ? {} : { customerReportId: report.id }),
  }, report === null ? "" : formatCustomerReportMessage(report));
}
