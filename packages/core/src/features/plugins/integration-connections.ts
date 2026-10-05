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
  ticketMapping: itopTicketMappingSchema.optional(),
  /** Changes on every save of a stored connection, so an approval can tell that credentials or settings were edited. */
  revision: z.string().max(100).optional(),
  auth: z.record(z.string(), z.string().max(16_384)),
}).strict();
export type IntegrationConnectionInput = z.infer<typeof integrationConnectionInputSchema>;

export const integrationConnectionSchema = integrationConnectionInputSchema.omit({ auth: true }).extend({
  target: z.string(),
  authMode: z.enum(["token", "username_password"]),
  availability: z.enum(["configured", "disabled", "plugin_unavailable", "credentials_missing"]),
  actions: z.array(z.object({ id: z.string(), title: z.string(), riskLevel: z.enum(["read", "write"]) })),
});
export type IntegrationConnection = z.infer<typeof integrationConnectionSchema>;

function validateVersionedConnection(connection: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): IntegrationConnectionInput {
  if (!plugin || plugin.id !== connection.pluginId) throw new Error("Plugin configuration is unavailable.");
  const config = validatePluginConnectionShape(plugin, connection.configVersion ?? 0, connection.config);
  const contract = requirePluginPersistence(plugin);
  normalizeIntegrationTarget(config[contract.destinationField]);
  const fields = new Map(plugin.auth.fields.map((field) => [field.key, field]));
  if (Object.keys(connection.auth).some((key) => !fields.has(key))) throw new Error("Unknown credential field.");
  if (!hasPluginCredentials(plugin, connection.auth)) throw new Error("Connection credentials are incomplete.");
  if (plugin.id !== "itop") return { ...connection, config, ticketMapping: undefined };
  // A ticket mapping sent beside the configuration is merged into it; one given inside the configuration wins.
  const ticketMapping = config.ticketMapping === undefined ? connection.ticketMapping : itopTicketMappingSchema.parse(config.ticketMapping);
  return { ...connection, config: ticketMapping === undefined || config.ticketMapping !== undefined ? config : { ...config, ticketMapping }, ticketMapping };
}

/** The destination must be an HTTP(S) URL without credentials, query or fragment. */
export function normalizeIntegrationTarget(value: unknown): string {
  const url = new URL(typeof value === "string" ? value : "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Connection URL must be HTTP(S) without embedded credentials, query, or fragment.");
  }
  let target = url.href;
  while (target.endsWith("/")) { target = target.slice(0, -1); }
  return target;
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
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Connection URL must be HTTP(S) without embedded credentials, query, or fragment.");
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
    // The target is read from the endpoint that requests really use, never from a stored copy.
    const destination = connection.config === undefined
      ? connection.auth[connection.pluginId === "itop" ? "baseUrl" : "apiBase"]
      : connection.config[plugin?.metadata?.persistence?.destinationField ?? "endpoint"];
    const url = new URL(typeof destination === "string" ? destination : "");
    target = `${url.origin}${url.pathname}`;
  } catch { /* Invalid endpoints are reported as unavailable. */ }
  return {
    id: connection.id,
    name: connection.name,
    pluginId: connection.pluginId,
    enabled: connection.enabled,
    target,
    authMode: connection.pluginId === "itop" &&
        !(connection.auth.authToken?.trim()) &&
        Boolean(connection.auth.username?.trim() && connection.auth.password?.trim())
      ? "username_password"
      : "token",
    config: connection.config ?? { endpoint: target, ...(connection.ticketMapping ? { ticketMapping: connection.ticketMapping } : {}) },
    configVersion: connection.configVersion ?? 1,
    ticketMapping: connection.ticketMapping,
    revision: connection.revision,
    availability: !connection.enabled ? "disabled"
      : !target || !hasIntegrationCredentials(connection, plugin) ? "credentials_missing"
      : plugin == null ? "plugin_unavailable" : "configured",
    actions: plugin?.actions.map(({ id, title, riskLevel }) => ({ id, title, riskLevel })) ?? [],
  };
}

/**
 * An edit that supplies no credential keeps the stored ones, so renaming a connection or changing a non-secret setting
 * never drops them. Credentials are carried only while the destination stays the same: a changed destination must be
 * given its own credentials, so stored secrets are never sent to a host the engineer did not enter them for.
 */
export function keepStoredCredentials(input: IntegrationConnectionInput, existing: IntegrationConnectionInput | undefined, plugin?: DesktopPluginDescriptor | null): IntegrationConnectionInput {
  if (existing === undefined || input.config === undefined || Object.values(input.auth).some((value) => value.trim().length > 0)) return input;
  if (describeIntegrationConnection(existing, plugin).target !== describeIntegrationConnection(input, plugin).target) return input;
  return { ...input, auth: existing.auth };
}
