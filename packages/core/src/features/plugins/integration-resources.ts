import { z } from "zod";
import type { IntegrationConnection } from "./integration-connections";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
export const integrationResourceSchema = z.object({
  threadId: z.string().min(1), connectionId: z.uuid(), connectionName: z.string(),
  resourceType: z.enum(["ticket", "document"]), externalId: z.string().min(1).max(200),
  url: z.url(), title: z.string(), state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  observedAt: z.string(),
});
export type IntegrationResource = z.infer<typeof integrationResourceSchema>;
export interface IntegrationResourceStore {
  list(threadId: string): Promise<IntegrationResource[]>;
  save(resources: IntegrationResource[]): Promise<void>;
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function safeUrl(value: unknown, base: string): string | undefined {
  if (!text(value)) return undefined;
  try { const url = new URL(text(value), base); const target = new URL(base); return url.protocol === "https:" && url.origin === target.origin && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
const DEFAULT_TICKET_STATE_KEYS = ["ref", "status", "agent_id", "team_id"];
const MAX_STATE_TEXT = 200;
/** Short scalars only: long text such as descriptions and logs is never kept on a resource card. */
function isStateValue(value: unknown): value is string | number | boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= MAX_STATE_TEXT);
}
/** A card title must be short too: a title field mapped to a long text attribute falls back to the reference. */
function shortText(value: unknown): string { return isStateValue(value) ? text(value) : ""; }
/** The attributes a follow-up needs: the mapped reference and state, plus whatever the mapping requires to assign a ticket. */
function ticketStateKeys(mapping: IntegrationConnection["ticketMapping"]): string[] {
  if (mapping === undefined) return DEFAULT_TICKET_STATE_KEYS;
  const assigned = (mapping.requiredFields.assign ?? []).map((key) => mapping.fields[key]).filter((key): key is string => key !== undefined);
  return [...new Set([mapping.referenceField, mapping.statusField, ...assigned])];
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
      const mapping = connection.ticketMapping;
      const state = Object.fromEntries(ticketStateKeys(mapping).filter((key) => isStateValue(fields[key])).map((key) => [key, fields[key]]));
      return [integrationResourceSchema.parse({ ...common, resourceType: "ticket", externalId, url: url.toString(), title: shortText(fields[mapping?.titleField ?? "title"]) || shortText(fields[mapping?.referenceField ?? "ref"]) || externalId, state })];
    });
  }
  const rows = Array.isArray(data.data) ? data.data : [data.data];
  return rows.slice(0, 50).flatMap((value) => {
    const row = record(value); const document = row.document === undefined ? row : record(row.document);
    const externalId = text(document.id); const url = safeUrl(document.url, connection.target);
    if (!externalId || !url) return [];
    const state = Object.fromEntries(["updatedAt", "publishedAt", "archivedAt", "collectionId"].filter((key) => typeof document[key] === "string").map((key) => [key, document[key]]));
    return [integrationResourceSchema.parse({ ...common, resourceType: "document", externalId, url, title: text(document.title) || externalId, state })];
  });
}
export class StoredIntegrationResources implements IntegrationResourceStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly credentials: DesktopPluginStoredAuthStore) {}
  private async read() { const raw = (await this.credentials.get("bitsentry.integration-resources.v1")).resources; return z.array(integrationResourceSchema).parse(raw === undefined ? [] : JSON.parse(String(raw))); }
  async list(threadId: string) { await this.pending; return (await this.read()).filter((row) => row.threadId === threadId); }
  async save(resources: IntegrationResource[]) {
    const task = this.pending.then(async () => {
      const rows = await this.read();
      for (const resource of resources) {
        const index = rows.findIndex((row) => row.threadId === resource.threadId && row.connectionId === resource.connectionId && row.resourceType === resource.resourceType && row.externalId === resource.externalId);
        if (index < 0) rows.push(resource);
        // Decided inside the serialized write, so a slow older observation cannot replace a newer one.
        else if (Date.parse(resource.observedAt) >= Date.parse(rows[index]!.observedAt)) rows[index] = resource;
      }
      await this.credentials.set("bitsentry.integration-resources.v1", { resources: JSON.stringify(rows) });
    });
    this.pending = task.catch(() => {});
    await task;
  }
}
