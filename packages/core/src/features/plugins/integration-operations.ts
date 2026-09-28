import { z } from "zod";
import { buildPluginInputSchema } from "./desktop-plugin-registry";
import type { IntegrationConnection } from "./integration-connections";
import type { DesktopPluginDescriptor, DesktopPluginExecutionResult } from "./plugins.types";

export const integrationOperationSchema = z.object({
  id: z.uuid(), threadId: z.string().min(1), connectionId: z.uuid(),
  connectionName: z.string(), target: z.string(), pluginId: z.string(), actionId: z.string(),
  input: z.record(z.string(), z.unknown()), publicUpdate: z.boolean(), requiresCloseRequest: z.boolean(),
  status: z.enum(["proposed", "executing", "succeeded", "failed", "uncertain", "cancelled"]),
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
  list(threadId: string) { return this.store.list(threadId); }

  async propose(threadId: string, request: IntegrationWriteRequest): Promise<IntegrationOperation> {
    const runtime = await this.resolve(request.connectionId);
    const input = validateWrite(runtime, request);
    const now = new Date().toISOString();
    const operation = integrationOperationSchema.parse({
      id: crypto.randomUUID(), threadId, connectionId: runtime.connection.id,
      connectionName: runtime.connection.name, target: runtime.connection.target,
      pluginId: runtime.plugin.id, actionId: request.actionId, input,
      ...classify(runtime, { ...request, input }), status: "proposed", createdAt: now, updatedAt: now,
    });
    await this.store.create(operation);
    return operation;
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
      await this.store.transition(id, "executing", {
        status: result.ok ? "succeeded" : "uncertain", result: result.data,
        message: result.ok ? undefined : "The remote system did not confirm success. Inspect the remote resource before retrying.",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      await this.store.transition(id, "executing", { status: "uncertain", message: "The request was interrupted. The remote change may have completed; inspect it before retrying.", updatedAt: new Date().toISOString() });
    }
    return this.owned(threadId, id);
  }
}
