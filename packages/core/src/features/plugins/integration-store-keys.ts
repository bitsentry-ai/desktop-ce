/** Records BitSentry keeps in the plugin credential store next to plugin credentials. */
export const INTEGRATION_CONNECTIONS_STORE_KEY = "bitsentry.integration-connections.v1";
export const INTEGRATION_OPERATIONS_STORE_KEY = "bitsentry.integration-operations.v1";

const INTERNAL_STORE_KEY_PREFIX = "bitsentry.integration-";

/** Internal records must never be reachable through the plugin credential handlers. */
export function isInternalStoredAuthKey(id: string): boolean {
  return id.trim().startsWith(INTERNAL_STORE_KEY_PREFIX);
}
