import { z } from "zod";
import { readNamesResource } from "./integration-resources";
import { buildPluginInputSchema } from "./desktop-plugin-registry";
import type { ItopTicketMapping } from "./itop-ticket-mapping";
import type { IntegrationConnection } from "./integration-connections";
import { ticketWriteOperationSchema } from "./itop-ticket-mapping";
import { readItopTicketState } from "./itop-ticket-state";
import type { DesktopPluginDescriptor, DesktopPluginExecutionResult } from "./plugins.types";

export const integrationOperationSchema = z.object({
  id: z.uuid(), threadId: z.string().min(1), connectionId: z.uuid(),
  connectionName: z.string(), target: z.string(), pluginId: z.string(), actionId: z.string(),
  input: z.record(z.string(), z.unknown()), publicUpdate: z.boolean(), requiresCloseRequest: z.boolean(),
  // Kept from the preview so approval can refuse when the plugin or the connection changed since.
  pluginVersion: z.string(), connectionRevision: z.string().optional(), ticketOperation: ticketWriteOperationSchema.optional(),
  status: z.enum(["proposed", "executing", "succeeded", "failed", "uncertain", "cancelled", "reconciled"]),
  createdAt: z.string(), updatedAt: z.string(), result: z.unknown().optional(), message: z.string().optional(),
});
export type IntegrationOperation = z.infer<typeof integrationOperationSchema>;
export type IntegrationWriteRequest = { connectionId: string; actionId: string; input: Record<string, unknown> };
export type IntegrationWriteMeta = { ticketOperation?: z.infer<typeof ticketWriteOperationSchema> };
export interface IntegrationOperationStore {
  list(threadId: string): Promise<IntegrationOperation[]>;
  get(id: string): Promise<IntegrationOperation | null>;
  create(operation: IntegrationOperation): Promise<void>;
  transition(id: string, expected: IntegrationOperation["status"], patch: Pick<IntegrationOperation, "status" | "updatedAt"> & Partial<Pick<IntegrationOperation, "result" | "message">>, expectedUpdatedAt?: string): Promise<boolean>;
}
export interface IntegrationWriteRuntime {
  connection: IntegrationConnection;
  plugin: DesktopPluginDescriptor;
  execute(request: IntegrationWriteRequest): Promise<DesktopPluginExecutionResult>;
  /** Runs a read-only action on the same connection snapshot that `execute` would use. */
  read(request: IntegrationWriteRequest): Promise<DesktopPluginExecutionResult>;
}

const activeExecutions = new Map<string, number>();

export function validateWrite(runtime: IntegrationWriteRuntime, request: IntegrationWriteRequest) {
  const action = runtime.plugin.actions.find((row) => row.id === request.actionId);
  if (runtime.connection.availability !== "configured" || action?.riskLevel !== "write" || ["delete_object", "delete_document"].includes(request.actionId)) throw new Error("This write is unavailable.");
  if (Object.keys(request.input).some((key) => !action.fields.some((field) => field.key === key))) throw new Error("Unknown action field.");
  const input = buildPluginInputSchema(action.fields).parse(request.input);
  if (action.fields.some((field) => field.required && (input[field.key] === undefined || input[field.key] === null || input[field.key] === ""))) throw new Error("Required fields are missing.");
  // An update must name the revision the engineer saw, or it could overwrite a newer edit.
  if (runtime.plugin.id === "outline" && action.id === "update_document" && !Number.isSafeInteger(input.lastRevision)) throw new Error("Read the current document revision before proposing an update.");
  return input;
}

function lifecycleTransition(runtime: IntegrationWriteRuntime, ticketOperation: IntegrationWriteMeta["ticketOperation"]) {
  return Object.entries(runtime.connection.ticketMapping?.stimuli ?? {}).find(([name]) => name === ticketOperation)?.[1];
}

export function classify(runtime: IntegrationWriteRuntime, request: IntegrationWriteRequest, ticketOperation: IntegrationWriteMeta["ticketOperation"]) {
  const mapping = runtime.connection.ticketMapping;
  const fields = runtime.plugin.id === "itop" ? z.record(z.string(), z.unknown()).parse(request.input.fields ?? {}) : {};
  if (runtime.plugin.id === "itop") {
    if (mapping === undefined || request.input.class !== mapping.className) throw new Error("Configure a matching ticket mapping before approving writes.");
    // Direct state changes bypass configured lifecycle semantics and are never approved. The state attribute is
    // configurable per connection, so both it and the common `status` name are refused.
    if (["status", mapping.statusField].some((attribute) => attribute in fields)) throw new Error("Use a configured lifecycle operation to change ticket status.");
    // A lifecycle write must come from the configured operation whose stimulus it carries.
    if (request.actionId === "apply_stimulus" && lifecycleTransition(runtime, ticketOperation)?.stimulus !== request.input.stimulus) throw new Error("This lifecycle transition is not configured.");
    // Whatever remains must be mapped, and the configured required fields must be present, even if the preview was made earlier.
    validateTicketFields(mapping, request, fields);
  }
  return {
    publicUpdate: runtime.plugin.id === "outline" || (mapping !== undefined && mapping.publicLogField in fields),
    requiresCloseRequest: runtime.plugin.id === "itop" && request.actionId === "apply_stimulus"
      && (ticketOperation === "close" || request.input.stimulus === mapping?.stimuli.close?.stimulus),
  };
}

/** The connection and plugin at approval must be the ones the engineer saw in the preview. */
function assertUnchanged(runtime: IntegrationWriteRuntime, operation: IntegrationOperation) {
  const { connection, plugin } = runtime;
  if (connection.target !== operation.target || plugin.id !== operation.pluginId || connection.revision !== operation.connectionRevision) throw new Error("Connection changed. Create a new preview.");
  if (plugin.version !== operation.pluginVersion) throw new Error("Plugin changed. Create a new preview.");
}

/** A lifecycle change is checked against the ticket's state now, not the state seen at preview time. */
export async function assertTicketState(runtime: IntegrationWriteRuntime, operation: IntegrationOperation) {
  if (runtime.plugin.id !== "itop" || operation.actionId !== "apply_stimulus") return;
  const mapping = runtime.connection.ticketMapping;
  const transition = lifecycleTransition(runtime, operation.ticketOperation);
  if (mapping === undefined || transition === undefined || transition.stimulus !== operation.input.stimulus || transition.from === undefined) throw new Error("Ticket mapping changed. Create a new preview.");
  let state: string | undefined;
  try {
    const read = await runtime.read({ connectionId: operation.connectionId, actionId: "get_object", input: { class: mapping.className, id: operation.input.id, outputFields: mapping.statusField } });
    state = read.ok ? readItopTicketState(read.data, mapping.statusField) : undefined;
  } catch {
    state = undefined;
  }
  if (state === undefined) throw new Error("Could not read the ticket state. Nothing was changed; retry.");
  if (!transition.from.includes(state)) throw new Error(`The ticket is in state "${state}"; ${String(operation.ticketOperation)} is only allowed from: ${transition.from.join(", ")}. Nothing was changed.`);
}

/** Approval is an application action; no agent tool receives this capability. */
export class IntegrationOperationService {
  constructor(private readonly store: IntegrationOperationStore, private readonly resolve: (id: string) => Promise<IntegrationWriteRuntime>) {}
  async list(threadId: string) {
    const rows = await this.store.list(threadId);
    for (const row of rows) {
      if (row.status === "executing" && Date.now() - Date.parse(row.updatedAt) > 120_000) {
        await this.store.transition(row.id, "executing", { status: "uncertain", updatedAt: new Date().toISOString(), message: "Execution has not confirmed completion. Inspect the remote system before recovery." }, row.updatedAt);
      }
    }
    const current = await this.store.list(threadId);
    return current.map((row) => row.status === "uncertain" && (activeExecutions.get(row.id) ?? 0) > 0
      ? { ...row, message: "The original write is still running. Wait for it to finish before reconciling." }
      : row);
  }

  async propose(threadId: string, request: IntegrationWriteRequest, meta: IntegrationWriteMeta = {}, renewalOf?: string): Promise<IntegrationOperation> {
    const runtime = await this.resolve(request.connectionId);
    const input = validateWrite(runtime, request);
    const now = new Date().toISOString();
    if (renewalOf === undefined) {
      const previous = (await this.store.list(threadId)).filter((row) => row.connectionId === request.connectionId && row.target === runtime.connection.target && row.pluginId === runtime.plugin.id && row.actionId === request.actionId && row.ticketOperation === meta.ticketOperation && JSON.stringify(canonical(row.input)) === JSON.stringify(canonical(input))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).find((row) => row.status !== "proposed" || (row.pluginVersion === runtime.plugin.version && row.connectionRevision === runtime.connection.revision));
      if (previous !== undefined) return previous;
    }
    const id = await proposalId({ threadId, connectionId: request.connectionId, pluginId: runtime.plugin.id, pluginVersion: runtime.plugin.version, connectionRevision: runtime.connection.revision ?? null, target: runtime.connection.target, actionId: request.actionId, input, ticketOperation: meta.ticketOperation ?? null, renewalOf: renewalOf ?? null });
    const existing = await this.store.get(id);
    if (existing !== null) return existing;
    const operation = integrationOperationSchema.parse({
      id, threadId, connectionId: runtime.connection.id,
      connectionName: runtime.connection.name, target: runtime.connection.target,
      pluginId: runtime.plugin.id, actionId: request.actionId, input,
      pluginVersion: runtime.plugin.version, connectionRevision: runtime.connection.revision, ticketOperation: meta.ticketOperation,
      ...classify(runtime, { ...request, input }, meta.ticketOperation), status: "proposed", createdAt: now, updatedAt: now,
    });
    try {
      await this.store.create(operation);
    } catch (error) {
      const concurrent = await this.store.get(id);
      if (concurrent !== null) return concurrent;
      throw error;
    }
    return operation;
  }

  async renew(threadId: string, id: string) {
    const previous = await this.owned(threadId, id);
    if (!["succeeded", "reconciled", "failed", "cancelled"].includes(previous.status)) throw new Error("Resolve the previous outcome before proposing a repeat.");
    return this.propose(threadId, { connectionId: previous.connectionId, actionId: previous.actionId, input: previous.input }, { ticketOperation: previous.ticketOperation }, previous.id);
  }

  async reconcile(threadId: string, id: string, applied: boolean, confirmed: boolean, externalId?: string) {
    const operation = await this.owned(threadId, id);
    if (!confirmed || operation.status !== "uncertain") throw new Error("Inspect the remote system and explicitly confirm the outcome first.");
    if ((activeExecutions.get(id) ?? 0) > 0) throw new Error("The original write is still running. Wait for it to finish before reconciling.");
    let result: unknown;
    if (applied) {
      if (!externalId) throw new Error("Provide the external resource ID you inspected.");
      const runtime = await this.resolve(operation.connectionId);
      assertUnchanged(runtime, operation);
      const request = recoveryRead(operation, externalId, runtime.plugin);
      if (runtime.plugin.actions.find((action) => action.id === request.actionId)?.riskLevel !== "read") throw new Error("Resource verification is unavailable.");
      const response = await runtime.read(request);
      // The read must return exactly the resource the engineer named, not just any successful answer.
      const matches = response.ok && readNamesResource(operation.pluginId, response.data, externalId, operation.pluginId === "itop" ? operation.input.class : undefined);
      if (!matches) throw new Error("The remote system did not return the exact remote resource you named, so it could not be verified. Keep this outcome uncertain.");
      result = response.data;
    }
    await this.store.transition(id, "uncertain", { status: applied ? "reconciled" : "failed", result, message: applied ? "The engineer confirmed the change and the remote resource was read successfully." : "The engineer inspected the remote system and confirmed that this operation did not apply.", updatedAt: new Date().toISOString() });
    return this.owned(threadId, id);
  }

  private async owned(threadId: string, id: string): Promise<IntegrationOperation> {
    const operation = await this.store.get(id);
    if (operation === null || operation.threadId !== threadId) throw new Error("Proposal not found in this conversation.");
    return operation;
  }

  async cancel(threadId: string, id: string) {
    await this.owned(threadId, id);
    await this.store.transition(id, "proposed", { status: "cancelled", updatedAt: new Date().toISOString() });
    return this.owned(threadId, id);
  }

  async approve(threadId: string, id: string, closeRequested: boolean): Promise<IntegrationOperation> {
    const operation = await this.owned(threadId, id);
    if (operation.status !== "proposed") return operation;
    if (operation.requiresCloseRequest && !closeRequested) throw new Error("Closing requires an explicit engineer request.");
    const runtime = await this.resolve(operation.connectionId);
    assertUnchanged(runtime, operation);
    validateWrite(runtime, operation);
    const flags = classify(runtime, operation, operation.ticketOperation);
    if (flags.requiresCloseRequest !== operation.requiresCloseRequest || flags.publicUpdate !== operation.publicUpdate) throw new Error("Ticket mapping changed. Create a new preview.");
    await assertTicketState(runtime, operation);
    return this.withExecutionFence(id, async () => {
      if (!await this.store.transition(id, "proposed", { status: "executing", updatedAt: new Date().toISOString() })) return this.owned(threadId, id);
      try {
        const result = await runtime.execute(operation);
        const patch = { ...remoteWriteOutcome(result), updatedAt: new Date().toISOString() };
        if (!await this.store.transition(id, "executing", patch)) await this.store.transition(id, "uncertain", patch);
      } catch {
        const patch = { status: "uncertain" as const, message: "The request was interrupted. The remote change may have completed; inspect it before retrying.", updatedAt: new Date().toISOString() };
        if (!await this.store.transition(id, "executing", patch)) await this.store.transition(id, "uncertain", patch);
      }
      return this.owned(threadId, id);
    });
  }

  private async withExecutionFence<T>(id: string, action: () => Promise<T>): Promise<T> {
    activeExecutions.set(id, (activeExecutions.get(id) ?? 0) + 1);
    try {
      return await action();
    } finally {
      const remaining = (activeExecutions.get(id) ?? 1) - 1;
      if (remaining === 0) activeExecutions.delete(id);
      else activeExecutions.set(id, remaining);
    }
  }
}

export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
async function proposalId(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function genericRecoveryRead(operation: IntegrationOperation, externalId: string, plugin?: DesktopPluginDescriptor): IntegrationWriteRequest {
    const resources = plugin?.metadata?.persistence?.resources ?? [];
    if (resources.length !== 1) throw new Error("Select a plugin-specific resource verifier before reconciliation.");
    const action = plugin?.actions.find((item) => item.id === resources[0].readActionId && item.riskLevel === "read");
    if (!action) throw new Error("Resource verification is unavailable.");
    if (operation.input.id !== undefined && String(operation.input.id) !== externalId) throw new Error("Verify the exact targeted resource.");
    const id = action.fields.find((field) => field.key === "id")?.type === "number" ? Number(externalId) : externalId;
    return { connectionId: operation.connectionId, actionId: action.id, input: buildPluginInputSchema(action.fields).parse({ id }) };
}

export function recoveryRead(operation: IntegrationOperation, externalId: string, plugin?: DesktopPluginDescriptor): IntegrationWriteRequest {
  if (operation.pluginId !== "itop" && operation.pluginId !== "outline") return genericRecoveryRead(operation, externalId, plugin);
  if (operation.pluginId === "itop") {
    const id = Number(externalId);
    if (!/^\d+$/.test(externalId) || !Number.isSafeInteger(id) || id < 1) throw new Error("Use the exact numeric iTop resource ID.");
    if (operation.actionId !== "create_object" && id !== Number(operation.input.id)) throw new Error("Verify the exact resource targeted by this operation.");
    return { connectionId: operation.connectionId, actionId: "get_object", input: { class: operation.input.class, id, outputFields: "*" } };
  }
  if (operation.actionId !== "create_document" && externalId !== operation.input.id) throw new Error("Verify the exact document targeted by this operation.");
  return { connectionId: operation.connectionId, actionId: "get_document", input: { id: externalId } };
}

/**
 * A remote system that clearly refused the request did not apply it, so the write failed with a reason the engineer can act on.
 * Anything else (a 5xx, a timeout, an unknown answer) stays uncertain and is never shown as success.
 */
export function remoteWriteOutcome(result: DesktopPluginExecutionResult): Pick<IntegrationOperation, "status" | "result" | "message"> {
  if (result.ok) return { status: "succeeded", result: result.data, message: undefined };
  const refused = [400, 401, 403, 404, 409, 422, 429].includes(result.status);
  const reasons: Record<number, string> = { 401: "credentials_rejected", 403: "credentials_rejected", 409: "stale_resource" };
  if (!refused) return { status: "uncertain", result: result.data, message: "The remote system did not confirm success. Inspect the remote resource before retrying." };
  return { status: "failed", result: result.data, message: reasons[result.status] ?? "remote_rejected" };
}

function validateTicketFields(mapping: ItopTicketMapping, request: IntegrationWriteRequest, fields: Record<string, unknown>) {
  const operations: Array<keyof ItopTicketMapping["requiredFields"]> = [];
  if (request.actionId === "create_object") operations.push("create");
  for (const operation of ["acknowledge", "assign", "resolve", "close"] as const) {
    if (request.actionId === "apply_stimulus" && request.input.stimulus === mapping.stimuli[operation]?.stimulus) operations.push(operation);
  }
  for (const [operation, field] of [["internal_log", mapping.internalLogField], ["public_log", mapping.publicLogField]] as const) {
    if (field in fields) {
      operations.push(operation);
      z.object({ add_item: z.object({ message: z.string().trim().min(1), format: z.literal("text") }).strict() }).strict().parse(fields[field]);
    }
  }
  const allowed = new Set([...Object.values(mapping.fields), mapping.internalLogField, mapping.publicLogField]);
  if (Object.keys(fields).some((field) => !allowed.has(field))) throw new Error("Use only configured ticket field mappings.");
  const missing = operations.flatMap((operation) => mapping.requiredFields[operation]).filter((key) => {
    const value = fields[mapping.fields[key]];
    return value === undefined || value === null || value === "";
  });
  if (missing.length) throw new Error(`Required ticket fields are missing: ${Array.from(new Set(missing)).join(", ")}`);
}
