import { z } from "zod";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
import { integrationConnectionInputSchema, keepStoredCredentials, validateIntegrationConnection, type IntegrationConnectionInput } from "./integration-connections";
import type { DesktopPluginDescriptor } from "./plugins.types";
import { INTEGRATION_CONNECTIONS_STORE_KEY as STORE_KEY } from "./integration-store-keys";

const connectionsSchema = z.array(integrationConnectionInputSchema).max(100);

const pendingWrites = new WeakMap<DesktopPluginStoredAuthStore, Promise<void>>();

/** Uses the product's credential store, including its encryption and atomic writes. */
export class IntegrationConnectionStore {
  constructor(private readonly credentials: DesktopPluginStoredAuthStore) {}

  async list(): Promise<IntegrationConnectionInput[]> {
    await pendingWrites.get(this.credentials);
    return this.read();
  }

  private async read(): Promise<IntegrationConnectionInput[]> {
    const stored = await this.credentials.get(STORE_KEY);
    if (stored.connections === undefined) return [];
    if (typeof stored.connections !== "string") throw new Error("Integration connection store is invalid.");
    return connectionsSchema.parse(JSON.parse(stored.connections));
  }

  private update(change: (rows: IntegrationConnectionInput[]) => IntegrationConnectionInput[]): Promise<void> {
    const operation = (pendingWrites.get(this.credentials) ?? Promise.resolve()).then(async () => {
      const rows = connectionsSchema.parse(change(await this.read()));
      await this.credentials.set(STORE_KEY, { connections: JSON.stringify(rows) });
    });
    pendingWrites.set(this.credentials, operation.catch(() => {}));
    return operation;
  }

  save(input: IntegrationConnectionInput, plugin?: DesktopPluginDescriptor | null): Promise<void> {
    // A malformed save is refused before it queues behind another write.
    integrationConnectionInputSchema.parse(input);
    return this.update((rows) => {
      const existing = rows.find((row) => row.id === input.id);
      const connection = validateIntegrationConnection(keepStoredCredentials(input, existing, plugin), plugin);
      if (rows.some((row) => row.id !== connection.id && row.name.toLowerCase() === connection.name.toLowerCase())) {
        throw new Error("A connection with that name already exists.");
      }
      if (existing !== undefined && existing.pluginId !== connection.pluginId) {
        throw new Error("A connection cannot change its plugin.");
      }
      // A new revision on every save lets a pending approval notice that the connection was edited.
      return [...rows.filter((row) => row.id !== connection.id), { ...connection, revision: crypto.randomUUID() }];
    });
  }

  remove(id: string): Promise<void> {
    return this.update((rows) => rows.filter((row) => row.id !== id));
  }
}
