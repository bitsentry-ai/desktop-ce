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
  fields: z.record(identifier, identifier),
  requiredFields: z.record(ticketWriteOperationSchema, z.array(identifier).max(50)),
  defaults: z.record(identifier, z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  stimuli: z.object({
    acknowledge: lifecycleTransitionSchema.optional(),
    assign: lifecycleTransitionSchema.optional(),
    resolve: lifecycleTransitionSchema.optional(),
    close: lifecycleTransitionSchema.optional(),
  }).strict(),
}).strict();
export type ItopTicketMapping = z.infer<typeof itopTicketMappingSchema>;
