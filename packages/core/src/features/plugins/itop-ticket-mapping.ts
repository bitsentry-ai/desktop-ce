import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z]\w*$/).max(100);
export const ticketWriteOperationSchema = z.enum(["create", "acknowledge", "assign", "internal_log", "public_log", "resolve", "close"]);
export const itopTicketMappingSchema = z.object({
  className: identifier,
  referenceField: identifier.default("ref"),
  titleField: identifier.default("title"),
  internalLogField: identifier.default("private_log"),
  publicLogField: identifier.default("public_log"),
  fields: z.record(identifier, identifier),
  requiredFields: z.record(ticketWriteOperationSchema, z.array(identifier).max(50)),
  defaults: z.record(identifier, z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  stimuli: z.object({ acknowledge: identifier.optional(), assign: identifier.optional(), resolve: identifier.optional(), close: identifier.optional() }).strict(),
}).strict();
export type ItopTicketMapping = z.infer<typeof itopTicketMappingSchema>;
