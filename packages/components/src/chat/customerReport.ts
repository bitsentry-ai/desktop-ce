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
  return toCustomerReportInput(draft, "thread", reportText) !== null;
}
