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
function stateUnavailable(cause: string): ToolResult {
  return { error: JSON.stringify({ code: "TICKET_STATE_UNAVAILABLE", cause, message: "Could not read the ticket's current state, so no proposal was created. Check the connection and ticket ID, then retry." }) };
}
type TicketMutation = { actionId: string; input: Record<string, unknown>; allowedStates?: string[] };
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

function mutationRequest(input: TicketOperationInput, mapping: ItopTicketMapping): TicketMutation | ToolResult {
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
  const transition = mapping.stimuli[input.operation];
  if (transition === undefined) return clarification("This lifecycle operation has no configured mapping. Ask the engineer to configure its iTop stimulus.", [input.operation]);
  if (transition.from === undefined) return clarification("This lifecycle operation has no allowed source states configured. Ask the engineer to configure them for this connection.", [input.operation]);
  return { actionId: "apply_stimulus", input: { ...common, id, stimulus: transition.stimulus }, allowedStates: transition.from };
}

/** Reads the mapped status field of one ticket through the selected connection's read path. */
async function readTicketState(context: HostToolContext, connectionId: string, mapping: ItopTicketMapping, id: unknown, plugins: Parameters<typeof runIntegrationTool>[1]): Promise<{ state: string } | ToolResult> {
  const read = await runIntegrationTool(context.integrationConnections, plugins, {
    connectionId, actionId: "get_object", input: { class: mapping.className, id, outputFields: mapping.statusField },
  }, "read");
  if (read.output === undefined) {
    const code = (JSON.parse(read.error ?? "{}") as { code?: unknown }).code;
    return stateUnavailable(typeof code === "string" ? code : "READ_FAILED");
  }
  try {
    const { content, truncated } = JSON.parse(read.output) as { content: string; truncated: boolean };
    if (truncated) return stateUnavailable("RESPONSE_TRUNCATED");
    const objects = Object.values((JSON.parse(content) as { objects?: Record<string, { fields?: Record<string, unknown> }> }).objects ?? {});
    const state = objects.length === 1 ? objects[0]?.fields?.[mapping.statusField] : undefined;
    return typeof state === "string" && state !== "" ? { state } : stateUnavailable("STATUS_FIELD_MISSING");
  } catch {
    return stateUnavailable("UNREADABLE_RESPONSE");
  }
}

function readOperation(
  context: HostToolContext, input: TicketOperationInput, mapping: ItopTicketMapping, plugins: Parameters<typeof runIntegrationTool>[1],
): Promise<ToolResult> | ToolResult {
  if (input.operation === "read" && /^\d+$/.test(input.ticketId ?? "") && (!Number.isSafeInteger(Number(input.ticketId)) || Number(input.ticketId) < 1)) return clarification("Use a positive numeric ticket ID or a human reference.", ["ticketId"]);
  if (input.operation === "read" && !input.ticketId) return clarification("Which ticket should be read?", ["ticketId"]);
  if (input.operation === "search" && !input.query) return clarification("What ticket title or reference should be searched?", ["query"]);
  return runIntegrationTool(context.integrationConnections, plugins, { connectionId: input.connectionId, ...readRequest(input, mapping) }, "read");
}

type ObservedTicketState = { field: string; value: string; allowedStates: string[] };

/** A lifecycle proposal is only allowed from a source state the connection's mapping permits. */
async function checkTicketState(
  context: HostToolContext, input: TicketOperationInput, mapping: ItopTicketMapping, id: unknown, allowedStates: string[],
  plugins: Parameters<typeof runIntegrationTool>[1],
): Promise<ObservedTicketState | ToolResult> {
  const observed = await readTicketState(context, input.connectionId, mapping, id, plugins);
  if (!("state" in observed)) return observed;
  if (!allowedStates.includes(observed.state)) {
    return { error: JSON.stringify({
      code: "INVALID_TICKET_STATE", operation: input.operation, currentState: observed.state, allowedStates,
      message: `The ticket is in state "${observed.state}"; ${input.operation} is only allowed from: ${allowedStates.join(", ")}. No proposal was created.`,
    }) };
  }
  return { field: mapping.statusField, value: observed.state, allowedStates };
}

export async function ticketOperation(context: HostToolContext, input: TicketOperationInput): Promise<ToolResult> {
  const connection = (await context.integrationConnections?.list())?.find((row) => row.id === input.connectionId);
  if (connection?.pluginId !== "itop" || connection.ticketMapping === undefined) return clarification("Choose an iTop connection with ticket field and lifecycle mappings configured.");
  const plugins = await context.pluginRuntime?.listPlugins() ?? [];
  if (input.operation === "read" || input.operation === "search") {
    return readOperation(context, input, connection.ticketMapping, plugins);
  }
  const request = mutationRequest(input, connection.ticketMapping);
  if (!("actionId" in request)) return request;
  const { allowedStates, ...action } = request;
  let observedTicketState: ObservedTicketState | undefined;
  if (allowedStates !== undefined) {
    const observed = await checkTicketState(context, input, connection.ticketMapping, action.input.id, allowedStates, plugins);
    if (!("value" in observed)) return observed;
    observedTicketState = observed;
  }
  const result = await runIntegrationTool(context.integrationConnections, plugins, { connectionId: input.connectionId, ...action }, "preview", { ticketOperation: true });
  if (result.output !== undefined) {
    const preview = JSON.parse(result.output) as Record<string, unknown>;
    result.output = JSON.stringify({
      ...preview, ticketOperation: input.operation, publicUpdate: input.operation === "public_log", requiresExplicitCloseRequest: input.operation === "close",
      ...(observedTicketState === undefined ? {} : { observedTicketState }),
    });
  }
  return result;
}
