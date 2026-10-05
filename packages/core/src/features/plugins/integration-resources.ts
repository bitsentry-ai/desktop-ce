import { z } from "zod";
import type { IntegrationConnection } from "./integration-connections";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
export const integrationResourceSchema = z.object({
  threadId: z.string().min(1), connectionId: z.uuid(), connectionName: z.string(),
  resourceType: z.string().min(1).max(100), externalId: z.string().min(1).max(200),
  url: z.url(), title: z.string(), state: z.record(z.string(), z.unknown()),
  stateVersion: z.number().int().positive().optional(),
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
const DEFAULT_TICKET_STATE_KEYS = ["ref", "status", "agent_id", "team_id"];
const MAX_STATE_TEXT = 200;
/** Short scalars only: long text such as descriptions and logs is never kept on a resource card. */
function isStateValue(value: unknown): value is string | number | boolean {
  return typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.length <= MAX_STATE_TEXT);
}
/** A card title must be short too: a title field mapped to a long text attribute falls back to the reference. */
/** A ticket ID that survives the number conversion the iTop read needs; anything larger would be rounded to another ticket. */
const isTicketId = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1;
function shortText(value: unknown): string { return isStateValue(value) ? text(value) : ""; }
/** The attributes a follow-up needs: the mapped reference and state, plus whatever the mapping requires to assign a ticket. */
function ticketStateKeys(mapping: IntegrationConnection["ticketMapping"]): string[] {
  if (mapping === undefined) return DEFAULT_TICKET_STATE_KEYS;
  const assigned = (mapping.requiredFields.assign ?? []).map((key) => mapping.fields[key]).filter((key): key is string => key !== undefined);
  return [...new Set([mapping.referenceField, mapping.statusField, ...assigned])];
}
/** `ticketClass` is the class the link was stored with; a later change of the mapping must not make an existing link unreadable. */
export function extractIntegrationResources(threadId: string, connection: Pick<IntegrationConnection, "id" | "name" | "pluginId" | "target" | "ticketMapping">, raw: unknown, ticketClass?: string): IntegrationResource[] {
  const data = record(raw);
  const now = new Date().toISOString();
  const common = { threadId, connectionId: connection.id, connectionName: connection.name, observedAt: now };
  if (connection.pluginId === "itop") {
    return Object.entries(record(data.objects)).slice(0, 50).flatMap(([key, value]) => {
      const object = record(value); const fields = record(object.fields);
      const externalId = text(object.key);
      const className = text(object.class) || key.split("::")[0];
      if (![ticketClass ?? connection.ticketMapping?.className ?? "UserRequest", "Incident", "Ticket"].includes(className)) return [];
      if (!isTicketId(externalId)) return [];
      const url = new URL("pages/UI.php", connection.target.replace(/\/?$/, "/"));
      url.search = new URLSearchParams({ operation: "details", class: className, id: externalId }).toString();
      const mapping = connection.ticketMapping;
      const state = Object.fromEntries(ticketStateKeys(mapping).filter((key) => isStateValue(fields[key])).map((key) => [key, fields[key]]));
      return [integrationResourceSchema.parse({ ...common, resourceType: "ticket", externalId, url: url.toString(), title: shortText(fields[mapping?.titleField ?? "title"]) || shortText(fields[mapping?.referenceField ?? "ref"]) || externalId, state: { ...state, className } })];
    });
  }
  if (connection.pluginId !== "outline") {
    const resources = Array.isArray(data.resources) ? data.resources : [];
    return resources.slice(0, 50).flatMap((value) => {
      const row = record(value);
      const url = safeUrl(row.url, connection.target);
      if (!url) return [];
      const parsed = integrationResourceSchema.safeParse({ ...row, ...common, url });
      return parsed.success ? [parsed.data] : [];
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
  /** Changes only `selected`, inside one serialized write, so a newer observation landing meanwhile is kept. */
  async select(threadId: string, connectionId: string, resourceType: string, externalId: string, selected: boolean) {
    const task = this.pending.then(async () => {
      const rows = await this.read();
      const row = rows.find((item) => item.threadId === threadId && item.connectionId === connectionId && item.resourceType === resourceType && item.externalId === externalId);
      if (!row) throw new Error("Linked resource not found.");
      row.selected = selected;
      await this.credentials.set("bitsentry.integration-resources.v1", { resources: JSON.stringify(rows) });
    });
    this.pending = task.catch(() => {});
    await task;
  }
  async save(resources: IntegrationResource[]) {
    const task = this.pending.then(async () => {
      const rows = await this.read();
      for (const resource of resources) {
        const index = rows.findIndex((row) => row.threadId === resource.threadId && row.connectionId === resource.connectionId && row.resourceType === resource.resourceType && row.externalId === resource.externalId);
        if (index < 0) rows.push(resource);
        // Decided inside the serialized write, so a slow older observation cannot replace a newer one.
        else if (Date.parse(resource.observedAt) >= Date.parse(rows[index]!.observedAt)) rows[index] = { ...resource, selected: resource.selected ?? rows[index]!.selected };
      }
      await this.credentials.set("bitsentry.integration-resources.v1", { resources: JSON.stringify(rows) });
    });
    this.pending = task.catch(() => {});
    await task;
  }
}

export const linkedResourceInputSchema = integrationResourceSchema.pick({ threadId: true, connectionId: true, resourceType: true, externalId: true }).strict();
export type LinkedResourceInput = z.infer<typeof linkedResourceInputSchema>;
/**
 * Reads the exact linked resource again. A card is only ever replaced by what the remote system returned for that same resource.
 * When the remote system says the resource is gone, the last known data is kept and only marked as deleted, so nothing the
 * engineer already saw or selected is lost.
 */
type RefreshRuntime = import("./integration-operations").IntegrationWriteRuntime;

/** The read action the plugin declares for a resource type; the first-party iTop and Outline names stay as the fallback. */
function resourceReadAction(plugin: import("./plugins.types").DesktopPluginDescriptor, resourceType: string): string | undefined {
  return plugin.metadata?.persistence?.resources.find((item) => item.type === resourceType)?.readActionId
    ?? (plugin.id === "itop" && resourceType === "ticket" ? "get_object" : plugin.id === "outline" && resourceType === "document" ? "get_document" : undefined);
}

/**
 * What reads this exact resource again: the read action its plugin declares for the type, with the ID in the form that
 * action's `id` field expects. Refuses, before anything is sent, a resource that cannot be read exactly.
 */
export function linkedResourceRead(
  plugin: import("./plugins.types").DesktopPluginDescriptor,
  ticketMapping: IntegrationConnection["ticketMapping"],
  resource: Pick<IntegrationResource, "resourceType" | "externalId" | "state">,
): { className: string | undefined; actionId: string; input: Record<string, unknown> } {
  const ticket = plugin.id === "itop" && resource.resourceType === "ticket";
  const actionId = resourceReadAction(plugin, resource.resourceType);
  const action = plugin.actions.find((item) => item.id === actionId);
  if (action?.riskLevel !== "read") throw new Error("Read capability is unavailable.");
  const className = typeof resource.state.className === "string" ? resource.state.className : ticketMapping?.className;
  if (ticket && typeof className !== "string") throw new Error("Ticket class is missing; read the exact ticket again.");
  if (ticket && !isTicketId(resource.externalId)) throw new Error("Ticket ID is outside the supported range.");
  const numericId = action.fields.find((field) => field.key === "id")?.type === "number";
  return { className, actionId: action.id, input: ticket ? { class: className, id: Number(resource.externalId), outputFields: "*" } : { id: numericId ? Number(resource.externalId) : resource.externalId } };
}

/** Refuses a refresh that cannot read the exact resource, before anything is sent. Returns what to read it with. */
function refreshPlan(input: LinkedResourceInput, resource: IntegrationResource | undefined, runtime: RefreshRuntime) {
  if (!resource || runtime.connection.id !== input.connectionId || runtime.connection.availability !== "configured") throw new Error("Linked resource or connection is unavailable.");
  const { className, actionId, input: readInput } = linkedResourceRead(runtime.plugin, runtime.connection.ticketMapping, resource);
  return { className, request: { connectionId: input.connectionId, actionId, input: readInput } };
}

/**
 * Reads the exact linked resource again. A card is only ever replaced by what the remote system returned for that same resource.
 * When the remote system says the resource is gone, the last known data is kept and only marked as deleted, so nothing the
 * engineer already saw or selected is lost.
 */
export async function refreshLinkedIntegrationResource(input: LinkedResourceInput, store: Pick<IntegrationResourceStore, "list" | "save">, runtime: RefreshRuntime): Promise<IntegrationResource> {
  const find = async () => (await store.list(input.threadId)).find((row) => row.connectionId === input.connectionId && row.resourceType === input.resourceType && row.externalId === input.externalId);
  const resource = await find();
  const { className, request } = refreshPlan(input, resource, runtime);
  // Stamped before the read: a slow answer must not claim a later observation than the one it saw.
  const observedAt = new Date().toISOString();
  const result = await runtime.read(request);
  // What is stored afterwards is returned, so a newer observation that landed meanwhile is never hidden by this answer.
  const keep = async (next: IntegrationResource) => { await store.save([next]); return (await find()) ?? next; };
  const markDeleted = () => keep({ ...resource!, state: { ...resource!.state, deleted: true }, observedAt });
  if (!result.ok) {
    if (result.status === 404) return markDeleted();
    throw new Error(result.status === 401 || result.status === 403 ? "Connection credentials were rejected." : "Resource is unavailable; access may have changed. Refresh again when the connection is restored.");
  }
  const next = extractIntegrationResources(input.threadId, runtime.connection, result.data, typeof className === "string" ? className : undefined).find((row) => row.externalId === input.externalId && row.resourceType === input.resourceType);
  if (next) return keep({ ...next, observedAt });
  // iTop answers a read of a missing object with success and no object. An object that is there but unusable is not a deletion.
  if (readNamesResource(runtime.connection.pluginId, result.data, input.externalId)) throw new Error("The remote response did not contain this exact resource.");
  return markDeleted();
}

/** Whether a read answer names exactly this resource: the same ID, and for iTop the same ticket class. A different resource never verifies it. */
export function readNamesResource(pluginId: string, data: unknown, externalId: string, className?: unknown): boolean {
  const root = record(data);
  if (pluginId === "itop") {
    // iTop keys each object as "Class::id" and repeats both inside it; either one identifies the ticket.
    return Object.entries(record(root.objects)).some(([key, value]) => {
      const object = record(value);
      const [mapClass, mapId] = key.split("::");
      return (text(object.key) || mapId) === externalId && (className === undefined || (text(object.class) || mapClass) === className);
    });
  }
  if (pluginId !== "outline") return (Array.isArray(root.resources) ? root.resources : []).some((value) => text(record(value).externalId) === externalId);
  const rows = Array.isArray(root.data) ? root.data : [root.data ?? root];
  return rows.some((value) => { const row = record(value); return text((row.document === undefined ? row : record(row.document)).id) === externalId; });
}
