import { z } from "zod";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
import { integrationConnectionInputSchema, validateIntegrationConnection, type IntegrationConnectionInput } from "./integration-connections";

const STORE_KEY = "bitsentry.integration-connections.v1";
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

  save(input: IntegrationConnectionInput): Promise<void> {
    const connection = validateIntegrationConnection(input);
    return this.update((rows) => {
      if (rows.some((row) => row.id !== connection.id && row.name.toLowerCase() === connection.name.toLowerCase())) {
        throw new Error("A connection with that name already exists.");
      }
      const existing = rows.find((row) => row.id === connection.id);
      if (existing !== undefined && existing.pluginId !== connection.pluginId) {
        throw new Error("A connection cannot change its plugin.");
      }
      return [...rows.filter((row) => row.id !== connection.id), connection];
    });
  }

  remove(id: string): Promise<void> {
    return this.update((rows) => rows.filter((row) => row.id !== id));
  }
}
