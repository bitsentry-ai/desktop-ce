import {
  customerReportInputSchema,
  isIanaTimeZone,
  zonedLocalToIso,
  type CustomerReportChannel,
  type CustomerReportInput,
} from "@bitsentry-ce/core/features/plugins";

/** What the composer holds while the engineer fills in a customer report. One client request ID per draft, reused on retry. */
export interface CustomerReportDraft {
  clientRequestId: string;
  channel: CustomerReportChannel;
  sender: string;
  /** `YYYY-MM-DDTHH:mm`, the value of a date-time input, read in `timeZone`. */
  receivedAtLocal: string;
  timeZone: string;
}

/** Hosts that support customer reports pass this to the composer. */
export interface ComposerCustomerReport {
  draft: CustomerReportDraft | null;
  onDraftChange: (draft: CustomerReportDraft | null) => void;
  /** The organization's time zone when the host knows it; otherwise the browser's zone is used. */
  defaultTimeZone?: string;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function createCustomerReportDraft(defaultTimeZone?: string): CustomerReportDraft {
  const timeZone = defaultTimeZone !== undefined && isIanaTimeZone(defaultTimeZone) ? defaultTimeZone : browserTimeZone();
  return { clientRequestId: crypto.randomUUID(), channel: "whatsapp", sender: "", receivedAtLocal: "", timeZone };
}

export function supportedTimeZones(selected: string): string[] {
  let zones: string[] = [];
  try {
    // Typed locally: older TypeScript lib targets do not declare this ES2022 method.
    const supported = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
    zones = supported === undefined ? [] : supported("timeZone");
  } catch {
    zones = [];
  }
  return zones.includes(selected) ? zones : [selected, ...zones];
}

/** The current wall-clock time in a time zone, as a date-time input value (`YYYY-MM-DDTHH:mm`). */
export function nowInTimeZone(timeZone: string, now: Date = new Date()): string {
  const zone = isIanaTimeZone(timeZone) ? timeZone : "UTC";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** The zone's current offset from UTC, e.g. `UTC+07:00`, or an empty string for an unknown zone. */
export function timeZoneOffsetLabel(timeZone: string, now: Date = new Date()): string {
  const iso = zonedLocalToIso(nowInTimeZone(timeZone, now), timeZone);
  return iso === null ? "" : `UTC${iso.slice(-6)}`;
}

/** Zones an engineer most likely needs first: the current choice, the organization's and browser's zones, Indonesia and UTC. */
export function suggestedTimeZones(selected: string, defaultTimeZone?: string): string[] {
  const candidates = [selected, defaultTimeZone, browserTimeZone(), "Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC"];
  return Array.from(new Set(candidates.filter((zone): zone is string => zone !== undefined && isIanaTimeZone(zone))));
}

/** A received time may be a few minutes ahead of this device's clock, but not later than that. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;
export type CustomerReportFieldIssue = "required" | "future";

/** What blocks the report's source fields from being saved. The report text is checked by the composer. */
export function customerReportDraftIssues(draft: CustomerReportDraft, now: Date = new Date()): { sender?: CustomerReportFieldIssue; receivedAt?: CustomerReportFieldIssue } {
  const issues: { sender?: CustomerReportFieldIssue; receivedAt?: CustomerReportFieldIssue } = {};
  if (draft.sender.trim() === "") issues.sender = "required";
  const receivedAt = zonedLocalToIso(draft.receivedAtLocal, draft.timeZone);
  if (receivedAt === null) issues.receivedAt = "required";
  else if (Date.parse(receivedAt) > now.getTime() + FUTURE_TOLERANCE_MS) issues.receivedAt = "future";
  return issues;
}

/** The report the host saves before it sends the message, or null while a required field is missing. */
export function toCustomerReportInput(draft: CustomerReportDraft, threadId: string, reportText: string): CustomerReportInput | null {
  const receivedAt = zonedLocalToIso(draft.receivedAtLocal, draft.timeZone);
  if (receivedAt === null) return null;
  const parsed = customerReportInputSchema.safeParse({
    threadId, clientRequestId: draft.clientRequestId, channel: draft.channel,
    sender: draft.sender.trim(), receivedAt, timeZone: draft.timeZone, reportText,
  });
  return parsed.success ? parsed.data : null;
}

export function isCustomerReportDraftReady(draft: CustomerReportDraft, reportText: string): boolean {
  return Object.keys(customerReportDraftIssues(draft)).length === 0 && toCustomerReportInput(draft, "thread", reportText) !== null;
}
