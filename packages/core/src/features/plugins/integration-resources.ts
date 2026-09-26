import { z } from "zod";
import type { IntegrationConnection } from "./integration-connections";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
export const integrationResourceSchema = z.object({
  threadId: z.string().min(1), connectionId: z.uuid(), connectionName: z.string(),
  resourceType: z.enum(["ticket", "document"]), externalId: z.string().min(1).max(200),
  url: z.url(), title: z.string(), state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  observedAt: z.string(), selected: z.boolean().optional(),
});
export type IntegrationResource = z.infer<typeof integrationResourceSchema>;
export interface IntegrationResourceStore {
  list(threadId: string): Promise<IntegrationResource[]>;
  save(resources: IntegrationResource[]): Promise<void>;
  select(threadId: string, connectionId: string, resourceType: string, externalId: string, selected: boolean): Promise<void>;
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function safeUrl(value: unknown, base: string): string | undefined {
  if (!text(value)) return undefined;
  try { const url = new URL(text(value), base); const target = new URL(base); return url.protocol === "https:" && url.origin === target.origin && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
export function extractIntegrationResources(threadId: string, connection: Pick<IntegrationConnection, "id" | "name" | "pluginId" | "target" | "ticketMapping">, raw: unknown): IntegrationResource[] {
  const data = record(raw);
  const now = new Date().toISOString();
  const common = { threadId, connectionId: connection.id, connectionName: connection.name, observedAt: now };
  if (connection.pluginId === "itop") {
    return Object.entries(record(data.objects)).slice(0, 50).flatMap(([key, value]) => {
      const object = record(value); const fields = record(object.fields);
      const externalId = text(object.key);
      const className = text(object.class) || key.split("::")[0];
      if (![connection.ticketMapping?.className ?? "UserRequest", "Incident", "Ticket"].includes(className)) return [];
      if (!/^\d+$/.test(externalId)) return [];
      const url = new URL("pages/UI.php", connection.target.replace(/\/?$/, "/"));
      url.search = new URLSearchParams({ operation: "details", class: className, id: externalId }).toString();
      const state = Object.fromEntries(["ref", "status", "agent_id", "team_id"].filter((key) => ["string", "number", "boolean"].includes(typeof fields[key])).map((key) => [key, fields[key]]));
      return [integrationResourceSchema.parse({ ...common, resourceType: "ticket", externalId, url: url.toString(), title: text(fields[connection.ticketMapping?.titleField ?? "title"]) || text(fields.ref) || externalId, state: { ...state, className } })];
    });
  }
  const rows = Array.isArray(data.data) ? data.data : [data.data];
  return rows.slice(0, 50).flatMap((value) => {
    const row = record(value); const document = row.document === undefined ? row : record(row.document);
    const externalId = text(document.id); const url = safeUrl(document.url, connection.target);
    if (!externalId || !url) return [];
    const state = Object.fromEntries(["updatedAt", "publishedAt", "archivedAt", "collectionId", "revision"].filter((key) => typeof document[key] === "string" || typeof document[key] === "number").map((key) => [key, document[key]]));
    return [integrationResourceSchema.parse({ ...common, resourceType: "document", externalId, url, title: text(document.title) || externalId, state })];
  });
}
export class StoredIntegrationResources implements IntegrationResourceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly credentials: DesktopPluginStoredAuthStore) {}
  private async read() { const raw = (await this.credentials.get("bitsentry.integration-resources.v1")).resources; return z.array(integrationResourceSchema).parse(raw === undefined ? [] : JSON.parse(String(raw))); }
  async list(threadId: string) { await this.pending; return (await this.read()).filter((row) => row.threadId === threadId); }
  async select(threadId: string, connectionId: string, resourceType: string, externalId: string, selected: boolean) {
    const resource = (await this.list(threadId)).find((row) => row.connectionId === connectionId && row.resourceType === resourceType && row.externalId === externalId);
    if (!resource) throw new Error("Linked resource not found.");
    await this.save([{ ...resource, selected }]);
  }
  async save(resources: IntegrationResource[]) {
    const task = this.pending.then(async () => {
      const rows = await this.read();
      for (const resource of resources) {
        const index = rows.findIndex((row) => row.threadId === resource.threadId && row.connectionId === resource.connectionId && row.resourceType === resource.resourceType && row.externalId === resource.externalId);
        if (index < 0) rows.push(resource); else rows[index] = { ...resource, selected: resource.selected ?? rows[index].selected };
      }
      await this.credentials.set("bitsentry.integration-resources.v1", { resources: JSON.stringify(rows) });
    });
    this.pending = task.catch(() => {});
    await task;
  }
}

export const linkedResourceInputSchema = integrationResourceSchema.pick({ threadId: true, connectionId: true, resourceType: true, externalId: true }).strict();
export type LinkedResourceInput = z.infer<typeof linkedResourceInputSchema>;
export async function refreshLinkedIntegrationResource(input: LinkedResourceInput, store: Pick<IntegrationResourceStore, "list" | "save">, runtime: import("./integration-operations").IntegrationWriteRuntime): Promise<IntegrationResource> {
  const resource = (await store.list(input.threadId)).find((row) => row.connectionId === input.connectionId && row.resourceType === input.resourceType && row.externalId === input.externalId);
  if (!resource || runtime.connection.id !== input.connectionId || runtime.connection.availability !== "configured") throw new Error("Linked resource or connection is unavailable.");
  const actionId = resource.resourceType === "ticket" ? "get_object" : "get_document";
  if (runtime.plugin.actions.find((action) => action.id === actionId)?.riskLevel !== "read") throw new Error("Read capability is unavailable.");
  const className = resource.state.className ?? runtime.connection.ticketMapping?.className;
  if (resource.resourceType === "ticket" && typeof className !== "string") throw new Error("Ticket class is missing; read the exact ticket again.");
  const request = { connectionId: input.connectionId, actionId, input: resource.resourceType === "ticket" ? { class: className, id: Number(input.externalId), outputFields: "*" } : { id: input.externalId } };
  const result = await runtime.execute(request);
  if (!result.ok) throw new Error(result.status === 401 || result.status === 403 ? "Connection credentials were rejected." : "Resource is unavailable; it may have been removed or access changed.");
  const next = extractIntegrationResources(input.threadId, runtime.connection, result.data).find((row) => row.externalId === input.externalId && row.resourceType === input.resourceType);
  if (!next) throw new Error("The remote response did not contain this exact resource.");
  const updated = { ...next, selected: resource.selected };
  await store.save([updated]);
  return updated;
}
