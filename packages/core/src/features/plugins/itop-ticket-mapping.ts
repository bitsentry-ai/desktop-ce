import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z]\w*$/).max(100);
const lifecycleTransitionSchema = z.object({
  stimulus: identifier,
  /** Source states this transition is allowed from, as stored in the connection's status field. */
  from: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
}).strict();
export const ticketWriteOperationSchema = z.enum(["create", "acknowledge", "assign", "internal_log", "public_log", "resolve", "close"]);
export type TicketWriteOperation = z.infer<typeof ticketWriteOperationSchema>;
export const itopTicketMappingSchema = z.object({
  className: identifier,
  referenceField: identifier.default("ref"),
  titleField: identifier.default("title"),
  internalLogField: identifier.default("private_log"),
  publicLogField: identifier.default("public_log"),
  statusField: identifier.default("status"),
  /** States in which a ticket counts as solved, for searching earlier solutions. */
  solvedStates: z.array(z.string().trim().min(1).max(100)).min(1).max(50).default(["resolved", "closed"]),
  fields: z.record(identifier, identifier),
  requiredFields: z.record(ticketWriteOperationSchema, z.array(identifier).max(50)),
  defaults: z.record(identifier, z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /**
   * The iTop attribute that records how a request arrived (`origin` on a stock UserRequest). When set, a ticket created
   * from a customer report records the report's channel there instead of the iTop default (`phone`).
   */
  originField: identifier.optional(),
  /** The origin value for each report channel, overriding `DEFAULT_CHANNEL_ORIGINS`. An unlisted channel keeps the iTop default. */
  channelOrigins: z.object({
    whatsapp: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(1).max(100).optional(),
    other: z.string().trim().min(1).max(100).optional(),
  }).strict().optional(),
  stimuli: z.object({
    acknowledge: lifecycleTransitionSchema.optional(),
    assign: lifecycleTransitionSchema.optional(),
    resolve: lifecycleTransitionSchema.optional(),
    close: lifecycleTransitionSchema.optional(),
  }).strict(),
}).strict();
export type ItopTicketMapping = z.infer<typeof itopTicketMappingSchema>;

/** Stock iTop `origin` values (in_person, chat, mail, phone, portal, monitoring) for each report channel. */
export const DEFAULT_CHANNEL_ORIGINS: Readonly<Record<"whatsapp" | "email" | "phone", string>> = { whatsapp: "chat", email: "mail", phone: "phone" };

/** The origin to record for a report channel, or undefined when the connection has no origin field or no value for it. */
export function customerReportOrigin(mapping: ItopTicketMapping, channel: "whatsapp" | "email" | "phone" | "other"): { field: string; value: string } | undefined {
  if (mapping.originField === undefined) return undefined;
  const value = mapping.channelOrigins?.[channel] ?? (channel === "other" ? undefined : DEFAULT_CHANNEL_ORIGINS[channel]);
  return value === undefined ? undefined : { field: mapping.originField, value };
}
