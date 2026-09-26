import { z } from "zod";
import type { HostToolContext } from "./host-tools";
import { runIntegrationTool } from "./integration-tools";
import type { ItopTicketMapping } from "../plugins/itop-ticket-mapping";
import type { ToolResult } from "./types";

export const ticketOperationToolSchema = z.object({
  connectionId: z.uuid(),
  operation: z.enum(["create", "search", "read", "acknowledge", "assign", "internal_log", "public_log", "resolve", "close"]),
  ticketId: z.string().min(1).max(100).optional().describe("Numeric external ID for writes; reads also accept a human ticket reference."),
  query: z.string().trim().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  message: z.string().trim().min(1).max(32_000).optional(),
}).strict();
export type TicketOperationInput = z.infer<typeof ticketOperationToolSchema>;

function clarification(message: string, fields: string[] = []): ToolResult {
  return { error: JSON.stringify({ code: "CLARIFICATION_REQUIRED", message, fields }) };
}
function oqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
function readRequest(input: TicketOperationInput, mapping: ItopTicketMapping) {
  const common = { class: mapping.className, outputFields: "*" };
  if (input.operation === "read" && /^\d+$/.test(input.ticketId ?? "")) {
    return { actionId: "get_object", input: { ...common, id: Number(input.ticketId) } };
  }
  const titleQuery = oqlString("%" + (input.query ?? "") + "%");
  const predicate = input.operation === "read"
    ? `${mapping.referenceField} = ${oqlString(input.ticketId ?? "")}`
    : `(${mapping.titleField} LIKE ${titleQuery} OR ${mapping.referenceField} = ${oqlString(input.query ?? "")})`;
  return { actionId: "list_objects", input: { ...common, query: `SELECT ${mapping.className} WHERE ${predicate}`, limit: input.operation === "read" ? 2 : input.limit, page: 1 } };
}

function mutationRequest(input: TicketOperationInput, mapping: ItopTicketMapping): { actionId: string; input: Record<string, unknown> } | ToolResult {
  if (input.operation === "search" || input.operation === "read") return clarification("Use a read operation.");
  const supplied = { ...mapping.defaults, ...input.fields };
  const required = mapping.requiredFields[input.operation];
  const missing = required.filter((key) => supplied[key] === undefined || supplied[key] === null || supplied[key] === "");
  if (missing.length > 0) return clarification("Ask the engineer for the configured required ticket fields.", missing);
  const unknown = Object.keys(supplied).filter((key) => !Object.keys(mapping.fields).includes(key));
  if (unknown.length > 0) return clarification("These field names are not mapped for this connection. Use the configured names.", unknown);
  const fields = Object.fromEntries(Object.entries(supplied).map(([key, value]) => [mapping.fields[key], value]));
  const common = { class: mapping.className, fields, outputFields: "*", comment: "BitSentry chat: engineer-reviewed ticket operation" };
  if (input.operation === "create") return { actionId: "create_object", input: common };
  const id = Number(input.ticketId);
  if (!/^\d+$/.test(input.ticketId ?? "") || !Number.isSafeInteger(id) || id < 1) return clarification("Read the ticket first and use its unambiguous numeric external ID.", ["ticketId"]);
  if (input.operation === "internal_log" || input.operation === "public_log") {
    if (!input.message) return clarification("Ask the engineer for the log entry content.", ["message"]);
    const field = input.operation === "public_log" ? mapping.publicLogField : mapping.internalLogField;
    return { actionId: "update_object", input: { ...common, id, fields: { ...fields, [field]: { add_item: { message: input.message, format: "text" } } } } };
  }
  const stimulus = mapping.stimuli[input.operation];
  if (stimulus === undefined) return clarification("This lifecycle operation has no configured mapping. Ask the engineer to configure its iTop stimulus.", [input.operation]);
  return { actionId: "apply_stimulus", input: { ...common, id, stimulus } };
}

export async function ticketOperation(context: HostToolContext, input: TicketOperationInput): Promise<ToolResult> {
  const connection = (await context.integrationConnections?.list())?.find((row) => row.id === input.connectionId);
  if (connection?.pluginId !== "itop" || connection.ticketMapping === undefined) return clarification("Choose an iTop connection with ticket field and lifecycle mappings configured.");
  const plugins = await context.pluginRuntime?.listPlugins() ?? [];
  if (input.operation === "read" || input.operation === "search") {
    if (input.operation === "read" && /^\d+$/.test(input.ticketId ?? "") && (!Number.isSafeInteger(Number(input.ticketId)) || Number(input.ticketId) < 1)) return clarification("Use a positive numeric ticket ID or a human reference.", ["ticketId"]);
    if (input.operation === "read" && !input.ticketId) return clarification("Which ticket should be read?", ["ticketId"]);
    if (input.operation === "search" && !input.query) return clarification("What ticket title or reference should be searched?", ["query"]);
    return runIntegrationTool(context.integrationConnections, plugins, { connectionId: input.connectionId, ...readRequest(input, connection.ticketMapping) }, "read");
  }
  const request = mutationRequest(input, connection.ticketMapping);
  if (!("actionId" in request)) return request;
  const result = await runIntegrationTool(context.integrationConnections, plugins, { connectionId: input.connectionId, ...request }, "preview");
  if (result.output !== undefined) {
    const preview = JSON.parse(result.output) as Record<string, unknown>;
    result.output = JSON.stringify({ ...preview, ticketOperation: input.operation, publicUpdate: input.operation === "public_log", requiresExplicitCloseRequest: input.operation === "close" });
  }
  return result;
}
