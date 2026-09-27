import { hasPluginCredentials, requirePluginPersistence, validatePluginConnectionShape } from "@bitsentry/plugin-sdk";
import { itopTicketMappingSchema } from "./itop-ticket-mapping";
import { z } from "zod";
import type { DesktopPluginDescriptor } from "./plugins.types";

export const integrationPluginIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
export const integrationConnectionInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  pluginId: integrationPluginIdSchema,
  enabled: z.boolean().default(true),
  configVersion: z.number().int().positive().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  target: z.string().optional(),
  ticketMapping: itopTicketMappingSchema.optional(),
  auth: z.record(z.string(), z.string().max(16_384)),
}).strict();
export type IntegrationConnectionInput = z.infer<typeof integrationConnectionInputSchema>;

export const integrationConnectionSchema = integrationConnectionInputSchema.omit({ auth: true }).extend({
  target: z.string(),
  availability: z.enum(["configured", "disabled", "plugin_unavailable", "credentials_missing", "destination_blocked"]),
  actions: z.array(z.object({ id: z.string(), title: z.string(), riskLevel: z.enum(["read", "write"]) })),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

function validateVersionedConnection(connection: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): IntegrationConnectionInput {
    if (!plugin || plugin.id !== connection.pluginId) throw new Error("Plugin configuration is unavailable.");
    const config = validatePluginConnectionShape(plugin, connection.configVersion ?? 0, connection.config);
    const contract = requirePluginPersistence(plugin);
    const target = normalizeIntegrationTarget(String(config[contract.destinationField]));
    if (connection.target !== undefined && normalizeIntegrationTarget(connection.target) !== target) throw new Error("Connection destination does not match its configuration.");
    const fields = new Map(plugin.auth.fields.map((field) => [field.key, field]));
    if (Object.keys(connection.auth).some((key) => !fields.has(key))) throw new Error("Unknown credential field.");
    if (!hasPluginCredentials(plugin, connection.auth)) throw new Error("Connection credentials are incomplete.");
    return { ...connection, config, target, ticketMapping: plugin.id !== "itop" || config.ticketMapping === undefined ? undefined : itopTicketMappingSchema.parse(config.ticketMapping) };
}

export function validateIntegrationConnection(input: unknown, plugin?: DesktopPluginDescriptor | null): IntegrationConnectionInput {
  const connection = integrationConnectionInputSchema.parse(input);
  if (connection.config !== undefined) return validateVersionedConnection(connection, plugin);
  // Compatibility decoder for connections from the original chat stack; removed after backfill.
  if (!["itop", "outline"].includes(connection.pluginId)) throw new Error("Versioned plugin configuration is required.");
  const allowed = connection.pluginId === "itop"
    ? ["baseUrl", "authToken", "username", "password"]
    : ["apiBase", "accessToken"];
  if (Object.keys(connection.auth).some((key) => !allowed.includes(key))) {
    throw new Error("Connection contains an unsupported credential field.");
  }
  const endpoint = connection.pluginId === "itop" ? connection.auth.baseUrl : connection.auth.apiBase;
  const url = new URL(endpoint ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Connection URL must be HTTPS without embedded credentials, query, or fragment.");
  }
  if (!hasIntegrationCredentials(connection)) throw new Error("Connection credentials are incomplete.");
  return connection;
}

export function hasIntegrationCredentials(connection: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): boolean {
  if (connection.config !== undefined) return plugin != null ? hasPluginCredentials(plugin, connection.auth) : Object.values(connection.auth).some((value) => value.trim().length > 0);
  const present = (key: string) => (connection.auth[key]?.trim().length ?? 0) > 0;
  return connection.pluginId === "itop"
    ? present("baseUrl") && (present("authToken") || (present("username") && present("password")))
    : present("apiBase") && present("accessToken");
}

/** Explicit projection: auth must never be spread into a model-visible descriptor. */
export function describeIntegrationConnection(
  connection: IntegrationConnectionInput,
  plugin?: DesktopPluginDescriptor | null,
): IntegrationConnection {
  let target = "";
  try {
    const url = new URL(connection.target ?? connection.auth[connection.pluginId === "itop" ? "baseUrl" : "apiBase"] ?? "");
    target = `${url.origin}${url.pathname}`;
  } catch { /* Invalid legacy endpoints are reported as unavailable. */ }
  return {
    id: connection.id,
    name: connection.name,
    pluginId: connection.pluginId,
    enabled: connection.enabled,
    target,
    config: connection.config ?? { endpoint: target, ...(connection.ticketMapping ? { ticketMapping: connection.ticketMapping } : {}) },
    configVersion: connection.configVersion ?? 1,
    ticketMapping: connection.ticketMapping,
    availability: !connection.enabled ? "disabled"
      : !target || !hasIntegrationCredentials(connection, plugin) ? "credentials_missing"
      : plugin == null ? "plugin_unavailable" : "configured",
    actions: plugin?.actions.map(({ id, title, riskLevel }) => ({ id, title, riskLevel })) ?? [],
  };
}

export function normalizeIntegrationTarget(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Integration target must use HTTPS without embedded credentials.");
  let target = url.href;
  while (target.endsWith("/")) { target = target.slice(0, -1); }
  return target;
}
export function applyIntegrationDestinationPolicy(connection: IntegrationConnection, policy: Record<string, string | undefined>): IntegrationConnection {
  if (connection.availability !== "configured") return connection;
  try {
    const target = normalizeIntegrationTarget(connection.target);
    const allowed = policy[connection.pluginId] ?? "";
    const targets = allowed.split(",").map((row) => row.trim()).filter(Boolean).map(normalizeIntegrationTarget);
    if (targets.includes(target) || (connection.pluginId === "outline" && target === "https://app.getoutline.com/api")) return connection;
  } catch { /* Invalid host configuration is unavailable, never a policy bypass. */ }
  return { ...connection, availability: "destination_blocked" };
}

export function parseIntegrationDestinationPolicy(value: string | undefined): Record<string, string> {
  if (!value?.trim()) return {};
  return z.record(z.string(), z.string()).parse(JSON.parse(value));
}
