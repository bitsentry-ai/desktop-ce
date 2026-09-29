import { z } from "zod";
import type { DesktopPluginStoredAuthStore } from "./desktop-plugin-auth-store";
import { integrationOperationSchema, type IntegrationOperation, type IntegrationOperationStore } from "./integration-operations";
import { INTEGRATION_OPERATIONS_STORE_KEY as KEY } from "./integration-store-keys";
export class StoredIntegrationOperations implements IntegrationOperationStore {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly credentials: DesktopPluginStoredAuthStore) {}
  private async read() {
    const value = (await this.credentials.get(KEY)).operations;
    return z.array(integrationOperationSchema).parse(value === undefined ? [] : JSON.parse(String(value)));
  }
  async list(threadId: string) { await this.pending; return (await this.read()).filter((row) => row.threadId === threadId); }
  async get(id: string) { await this.pending; return (await this.read()).find((row) => row.id === id) ?? null; }
  private update(change: (rows: IntegrationOperation[]) => boolean): Promise<boolean> {
    const task = this.pending.then(async () => {
      const rows = await this.read();
      if (!change(rows)) return false;
      await this.credentials.set(KEY, { operations: JSON.stringify(rows) });
      return true;
    });
    this.pending = task.catch(() => {});
    return task;
  }
  async create(operation: IntegrationOperation) { await this.update((rows) => { if (rows.some((row) => row.id === operation.id)) { throw new Error("Duplicate proposal."); } rows.push(operation); return true; }); }
  transition(id: string, expected: IntegrationOperation["status"], patch: Pick<IntegrationOperation, "status" | "updatedAt"> & Partial<Pick<IntegrationOperation, "result" | "message">>) {
    return this.update((rows) => { const index = rows.findIndex((row) => row.id === id && row.status === expected); if (index < 0) { return false; } rows[index] = integrationOperationSchema.parse({ ...rows[index], ...patch }); return true; });
  }
}
