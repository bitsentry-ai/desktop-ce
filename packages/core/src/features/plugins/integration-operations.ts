import { z } from "zod";
import { extractIntegrationResources } from "./integration-resources";
import { buildPluginInputSchema } from "./desktop-plugin-registry";
import type { IntegrationConnection } from "./integration-connections";
import type { DesktopPluginDescriptor, DesktopPluginExecutionResult } from "./plugins.types";

export const integrationOperationSchema = z.object({
  id: z.uuid(), threadId: z.string().min(1), connectionId: z.uuid(),
  connectionName: z.string(), target: z.string(), pluginId: z.string(), actionId: z.string(),
  input: z.record(z.string(), z.unknown()), publicUpdate: z.boolean(), requiresCloseRequest: z.boolean(),
  status: z.enum(["proposed", "executing", "succeeded", "failed", "uncertain", "cancelled", "reconciled"]),
  createdAt: z.string(), updatedAt: z.string(), result: z.unknown().optional(), message: z.string().optional(),
});
export type IntegrationOperation = z.infer<typeof integrationOperationSchema>;
export type IntegrationWriteRequest = { connectionId: string; actionId: string; input: Record<string, unknown> };
export interface IntegrationOperationStore {
  list(threadId: string): Promise<IntegrationOperation[]>;
  get(id: string): Promise<IntegrationOperation | null>;
  create(operation: IntegrationOperation): Promise<void>;
  transition(id: string, expected: IntegrationOperation["status"], patch: Pick<IntegrationOperation, "status" | "updatedAt"> & Partial<Pick<IntegrationOperation, "result" | "message">>): Promise<boolean>;
}
export interface IntegrationWriteRuntime {
  connection: IntegrationConnection;
  plugin: DesktopPluginDescriptor;
  execute(request: IntegrationWriteRequest): Promise<DesktopPluginExecutionResult>;
}

function validateWrite(runtime: IntegrationWriteRuntime, request: IntegrationWriteRequest) {
  const action = runtime.plugin.actions.find((row) => row.id === request.actionId);
  if (runtime.connection.availability !== "configured" || action?.riskLevel !== "write" || ["delete_object", "delete_document"].includes(request.actionId)) throw new Error("This write is unavailable.");
  if (Object.keys(request.input).some((key) => !action.fields.some((field) => field.key === key))) throw new Error("Unknown action field.");
  const input = buildPluginInputSchema(action.fields).parse(request.input);
  if (action.fields.some((field) => field.required && (input[field.key] === undefined || input[field.key] === null || input[field.key] === ""))) throw new Error("Required fields are missing.");
  if (runtime.plugin.id === "outline" && action.id === "update_document" && !Number.isSafeInteger(input.lastRevision)) throw new Error("Read the current document revision before proposing an update.");
  return input;
}

function classify(runtime: IntegrationWriteRuntime, request: IntegrationWriteRequest) {
  const mapping = runtime.connection.ticketMapping;
  const fields = z.record(z.string(), z.unknown()).parse(request.input.fields ?? {});
  if (runtime.plugin.id === "itop") {
    if (mapping === undefined || request.input.class !== mapping.className) throw new Error("Configure a matching ticket mapping before approving writes.");
    // Direct state changes bypass configured lifecycle semantics and are never approved.
    if ("status" in fields) throw new Error("Use a configured lifecycle operation to change ticket status.");
    if (request.actionId === "apply_stimulus" && !Object.values(mapping.stimuli).includes(String(request.input.stimulus))) throw new Error("This lifecycle transition is not configured.");
  }
  return {
    publicUpdate: runtime.plugin.id === "outline" || (mapping !== undefined && mapping.publicLogField in fields),
    requiresCloseRequest: runtime.plugin.id === "itop" && request.actionId === "apply_stimulus" && request.input.stimulus === mapping?.stimuli.close,
  };
}

/** Approval is an application action; no agent tool receives this capability. */
export class IntegrationOperationService {
  constructor(private readonly store: IntegrationOperationStore, private readonly resolve: (id: string) => Promise<IntegrationWriteRuntime>) {}
  async list(threadId: string) {
    const rows = await this.store.list(threadId);
    for (const row of rows) {
      if (row.status === "executing" && Date.now() - Date.parse(row.updatedAt) > 120_000) {
        await this.store.transition(row.id, "executing", { status: "uncertain", updatedAt: new Date().toISOString(), message: "Execution has not confirmed completion. Inspect the remote system before recovery." });
      }
    }
    return this.store.list(threadId);
  }

  async propose(threadId: string, request: IntegrationWriteRequest, renewalOf?: string): Promise<IntegrationOperation> {
    const runtime = await this.resolve(request.connectionId);
    const input = validateWrite(runtime, request);
    const now = new Date().toISOString();
    if (renewalOf === undefined) {
      const previous = (await this.store.list(threadId)).filter((row) => row.connectionId === request.connectionId && row.target === runtime.connection.target && row.actionId === request.actionId && JSON.stringify(canonical(row.input)) === JSON.stringify(canonical(input))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (previous !== undefined) return previous;
    }
    const id = await proposalId({ threadId, connectionId: request.connectionId, target: runtime.connection.target, actionId: request.actionId, input, renewalOf: renewalOf ?? null });
    const existing = await this.store.get(id);
    if (existing !== null) return existing;
    const operation = integrationOperationSchema.parse({
      id, threadId, connectionId: runtime.connection.id,
      connectionName: runtime.connection.name, target: runtime.connection.target,
      pluginId: runtime.plugin.id, actionId: request.actionId, input,
      ...classify(runtime, { ...request, input }), status: "proposed", createdAt: now, updatedAt: now,
    });
    try { await this.store.create(operation); }
    catch (error) { const concurrent = await this.store.get(id); if (concurrent !== null) { return concurrent; } throw error; }
    return operation;
  }

  /** Only the application exposes this explicit repeat/recovery capability. */
  async renew(threadId: string, id: string) {
    const previous = await this.owned(threadId, id);
    if (!["succeeded", "reconciled", "failed", "cancelled"].includes(previous.status)) throw new Error("Resolve the previous outcome before proposing a repeat.");
    return this.propose(threadId, previous, previous.id);
  }

  async reconcile(threadId: string, id: string, applied: boolean, confirmed: boolean, externalId?: string) {
    const operation = await this.owned(threadId, id);
    if (!confirmed || operation.status !== "uncertain") throw new Error("Inspect the remote system and explicitly confirm the outcome first.");
    let result: unknown;
    if (applied) {
      if (!externalId) throw new Error("Provide the external resource ID you inspected.");
      const runtime = await this.resolve(operation.connectionId);
      if (runtime.connection.target !== operation.target || runtime.plugin.id !== operation.pluginId) throw new Error("Restore the original connection target before reconciliation.");
      const request = recoveryRead(operation, externalId);
      if (runtime.plugin.actions.find((action) => action.id === request.actionId)?.riskLevel !== "read") throw new Error("Resource verification is unavailable.");
      const response = await runtime.execute(request);
      if (!response.ok || !extractIntegrationResources(threadId, runtime.connection, response.data, typeof operation.input.class === "string" ? operation.input.class : undefined).some((row) => row.externalId === externalId && (operation.pluginId !== "itop" || row.state.className === operation.input.class))) throw new Error("The exact remote resource could not be verified. Keep this outcome uncertain.");
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
    if (runtime.connection.target !== operation.target || runtime.plugin.id !== operation.pluginId) throw new Error("Connection changed. Create a new preview.");
    validateWrite(runtime, operation);
    const flags = classify(runtime, operation);
    if (flags.requiresCloseRequest !== operation.requiresCloseRequest || flags.publicUpdate !== operation.publicUpdate) throw new Error("Ticket mapping changed. Create a new preview.");
    if (!await this.store.transition(id, "proposed", { status: "executing", updatedAt: new Date().toISOString() })) return this.owned(threadId, id);
    try {
      const result = await runtime.execute(operation);
      const recorded = await this.store.transition(id, "executing", {
        ...remoteWriteOutcome(result),
        updatedAt: new Date().toISOString(),
      });
      if (!recorded && result.ok) await this.store.transition(id, "uncertain", { status: "succeeded", result: result.data, message: undefined, updatedAt: new Date().toISOString() });
    } catch {
      await this.store.transition(id, "executing", { status: "uncertain", message: "The request was interrupted. The remote change may have completed; inspect it before retrying.", updatedAt: new Date().toISOString() });
    }
    return this.owned(threadId, id);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
async function proposalId(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(value))))).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function recoveryRead(operation: IntegrationOperation, externalId: string): IntegrationWriteRequest {
  if (operation.pluginId === "itop") {
    const id = Number(externalId);
    if (!/^\d+$/.test(externalId) || !Number.isSafeInteger(id) || id < 1) throw new Error("Use the exact numeric iTop resource ID.");
    if (operation.actionId !== "create_object" && id !== Number(operation.input.id)) throw new Error("Verify the exact resource targeted by this operation.");
    return { connectionId: operation.connectionId, actionId: "get_object", input: { class: operation.input.class, id, outputFields: "*" } };
  }
  if (operation.actionId !== "create_document" && externalId !== operation.input.id) throw new Error("Verify the exact document targeted by this operation.");
  return { connectionId: operation.connectionId, actionId: "get_document", input: { id: externalId } };
}

function remoteWriteOutcome(result: DesktopPluginExecutionResult): Pick<IntegrationOperation, "status" | "result" | "message"> {
  if (result.ok) return { status: "succeeded", result: result.data, message: undefined };
  const rejected = [400, 401, 403, 404, 409, 422, 429].includes(result.status);
  const messages: Record<number, string> = { 401: "credentials_rejected", 403: "credentials_rejected", 409: "stale_resource" };
  return { status: rejected ? "failed" : "uncertain", result: result.data, message: messages[result.status] ?? (rejected ? "remote_rejected" : "uncertain") };
}
