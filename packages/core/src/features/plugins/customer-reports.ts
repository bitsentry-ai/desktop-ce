import { z } from "zod";

/** Where an engineer received a customer report. The same list is used by storage, validation and the composer. */
export const customerReportChannels = ["whatsapp", "email", "phone", "other"] as const;
export type CustomerReportChannel = (typeof customerReportChannels)[number];

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** What the engineer submits. Sender and received time are as provided; BitSentry cannot verify them. */
export const customerReportInputSchema = z.object({
  threadId: z.string().min(1).max(200),
  clientRequestId: z.uuid(),
  channel: z.enum(customerReportChannels),
  sender: z.string().trim().min(1).max(200),
  receivedAt: z.string().regex(ISO_WITH_OFFSET).refine((value) => !Number.isNaN(Date.parse(value))),
  timeZone: z.string().min(1).max(64).refine(isIanaTimeZone),
  reportText: z.string().min(1).max(30_000).refine((value) => value.trim().length > 0),
}).strict();
export type CustomerReportInput = z.infer<typeof customerReportInputSchema>;

export const customerReportSchema = customerReportInputSchema.extend({
  id: z.uuid(),
  submittedBy: z.string().min(1).max(200),
  operationId: z.string().nullable(),
  createdAt: z.string(),
});
export type CustomerReport = z.infer<typeof customerReportSchema>;

/** The source details shown with a ticket proposal. The original text stays in the report and the private log. */
export const customerReportSummarySchema = customerReportSchema.pick({
  id: true, channel: true, sender: true, receivedAt: true, timeZone: true, submittedBy: true,
});
export type CustomerReportSummary = z.infer<typeof customerReportSummarySchema>;

export function summarizeCustomerReport(report: CustomerReport): CustomerReportSummary {
  const { id, channel, sender, receivedAt, timeZone, submittedBy } = report;
  return customerReportSummarySchema.parse({ id, channel, sender, receivedAt, timeZone, submittedBy });
}

/** A store that keeps reports per conversation. `link` moves the report to a new create operation only if it still points to `expected`. */
export interface CustomerReportStore {
  save(input: CustomerReportInput, submittedBy: string): Promise<CustomerReport>;
  get(threadId: string, id: string): Promise<CustomerReport | null>;
  link(threadId: string, id: string, expected: string | null, operationId: string): Promise<boolean>;
}

const CHANNEL_LABELS: Record<CustomerReportChannel, string> = { whatsapp: "WhatsApp", email: "Email", phone: "Phone", other: "Other" };
export const customerReportMarker = (id: string) => `bitsentry-customer-report:${id}`;

/**
 * The private-log entry that carries the report into iTop. It contains no current time, so a retry builds the
 * same text and the duplicate checks see the same request.
 */
export function customerReportProvenance(report: CustomerReport): string {
  return [
    "Customer report (engineer-provided, not verified by BitSentry)",
    `Channel: ${CHANNEL_LABELS[report.channel]}`,
    `Sender: ${report.sender}`,
    `Received: ${report.receivedAt} (${report.timeZone})`,
    `Submitted by: ${report.submittedBy}`,
    "--- Original report ---",
    report.reportText,
    "--- End of report ---",
    customerReportMarker(report.id),
  ].join("\n");
}

/** One header line in the chat message names the report, so the chat can show it and the agent can refer to it. */
const MESSAGE_PREFIX = "[customer-report]";
const messageHeaderSchema = customerReportSummarySchema.omit({ submittedBy: true });
export type CustomerReportMessageHeader = z.infer<typeof messageHeaderSchema>;

export function formatCustomerReportMessage(report: CustomerReport): string {
  const { id, channel, sender, receivedAt, timeZone } = report;
  const header = messageHeaderSchema.parse({ id, channel, sender, receivedAt, timeZone });
  return `${MESSAGE_PREFIX}${JSON.stringify(header)}\n${report.reportText}`;
}

export function parseCustomerReportMessage(text: string): { header: CustomerReportMessageHeader; body: string } | null {
  if (!text.startsWith(MESSAGE_PREFIX)) return null;
  const end = text.indexOf("\n");
  const line = end === -1 ? text : text.slice(0, end);
  try {
    const header = messageHeaderSchema.safeParse(JSON.parse(line.slice(MESSAGE_PREFIX.length)));
    return header.success ? { header: header.data, body: end === -1 ? "" : text.slice(end + 1) } : null;
  } catch {
    return null;
  }
}

/** The answer a remote system gives when it refused a write before writing anything. */
export const REFUSED_BEFORE_WRITE = "refused_before_write";
/** The outcome recorded when the engineer inspected the remote system and confirmed nothing was applied. */
export const NOT_APPLIED_MESSAGE = "The engineer inspected the remote system and confirmed that this operation did not apply.";

type LinkedOperation = { status: string; message?: string; result?: unknown };

/**
 * Whether a report may get a new create operation, given the one it points to now.
 * - create: no ticket exists (none yet, cancelled, refused before writing, or confirmed not applied).
 * - reuse: the ticket exists, so the earlier operation is the answer.
 * - refuse: the outcome is open or unknown; a new create could duplicate the ticket.
 */
export function customerReportLinkDecision(linked: LinkedOperation | null): "create" | "reuse" | "refuse" {
  if (linked === null || linked.status === "cancelled") return "create";
  if (linked.status === "failed") return linked.message === REFUSED_BEFORE_WRITE || linked.message === NOT_APPLIED_MESSAGE ? "create" : "refuse";
  if (linked.status === "reconciled") return linked.result === undefined || linked.result === null ? "create" : "reuse";
  if (linked.status === "succeeded") return "reuse";
  return "refuse";
}

export class CustomerReportLinkError extends Error {
  constructor(readonly code: "CUSTOMER_REPORT_NOT_FOUND" | "CUSTOMER_REPORT_PENDING" | "CUSTOMER_REPORT_UNRESOLVED" | "CUSTOMER_REPORT_CHANGED", message: string) {
    super(message);
    this.name = "CustomerReportLinkError";
  }
}

export function customerReportRefusal(linked: LinkedOperation): CustomerReportLinkError {
  if (linked.status === "proposed") {
    return new CustomerReportLinkError("CUSTOMER_REPORT_PENDING", "A ticket proposal for this customer report is already waiting for approval. Ask the engineer to approve or reject it before proposing another one.");
  }
  return new CustomerReportLinkError("CUSTOMER_REPORT_UNRESOLVED", "The earlier ticket create for this customer report has no confirmed outcome. Ask the engineer to inspect iTop and confirm whether the ticket exists before creating another one. No write was proposed.");
}

/**
 * Converts a wall-clock time in a time zone ("2026-10-15T09:12" in "Asia/Jakarta") to ISO 8601 with that zone's offset.
 * The offset is found by comparing the zone's clock with UTC, and checked once more for daylight-saving edges.
 */
export function zonedLocalToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (match === null || !isIanaTimeZone(timeZone)) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(instant)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant;
  };
  let offset = offsetAt(wall);
  offset = offsetAt(wall - offset);
  const minutes = Math.round(offset / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${local}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
