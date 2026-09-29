import { itopTicketMappingSchema } from "./itop-ticket-mapping";
import { z } from "zod";
import type { DesktopPluginDescriptor } from "./plugins.types";

export const integrationPluginIdSchema = z.enum(["itop", "outline"]);
export const integrationConnectionInputSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  pluginId: integrationPluginIdSchema,
  enabled: z.boolean().default(true),
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

export function validateIntegrationConnection(input: unknown): IntegrationConnectionInput {
  const connection = integrationConnectionInputSchema.parse(input);
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

export function hasIntegrationCredentials(connection: IntegrationConnectionInput): boolean {
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
    const url = new URL(connection.auth[connection.pluginId === "itop" ? "baseUrl" : "apiBase"] ?? "");
    target = `${url.origin}${url.pathname}`;
  } catch { /* Invalid legacy endpoints are reported as unavailable. */ }
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
    ticketMapping: connection.ticketMapping,
    revision: connection.revision,
    availability: !connection.enabled ? "disabled"
      : !target || !hasIntegrationCredentials(connection) ? "credentials_missing"
      : plugin == null ? "plugin_unavailable" : "configured",
    actions: plugin?.actions.map(({ id, title, riskLevel }) => ({ id, title, riskLevel })) ?? [],
  };
}
