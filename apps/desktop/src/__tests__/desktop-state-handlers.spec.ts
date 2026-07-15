import { describe, expect, it, vi } from "vitest";

import {
  createDesktopStateHandlers,
  type DesktopStateDatabase,
} from "@bitsentry-ce/core/features/desktop-state/desktop-state.handlers";

function createNoopTable() {
  return {
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
  };
}

function createDesktopStateDatabase(): {
  db: DesktopStateDatabase;
  runbookActionCreate: ReturnType<typeof vi.fn>;
} {
  const runbookActionCreate = vi.fn().mockResolvedValue({});
  const runbookAction = {
    ...createNoopTable(),
    create: runbookActionCreate,
  };
  const db = {
    legacyImportLedger: createNoopTable(),
    incidentMessage: createNoopTable(),
    incidentThread: createNoopTable(),
    runbook: createNoopTable(),
    runbookAction,
    runbookVersion: createNoopTable(),
    investigationSession: createNoopTable(),
    investigationTraceEntry: createNoopTable(),
    investigationToolRun: createNoopTable(),
    investigationReport: createNoopTable(),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };

  const dbHandle: unknown = db;
  return { db: dbHandle as DesktopStateDatabase, runbookActionCreate };
}

describe("desktop state handlers", () => {
  it("round-trips plugin runbook action fields through syncRunbooks storage columns", async () => {
    const { db, runbookActionCreate } = createDesktopStateDatabase();
    const handlers = createDesktopStateHandlers(db);

    await expect(
      handlers["desktopState:syncRunbooks"]({
        runbooks: [
          {
            id: "runbook-1",
            title: "Plugin runbook",
            description: "",
            revisionNumber: 1,
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-01T00:00:00.000Z",
            actions: [
              {
                id: "action-1",
                type: "plugin",
                title: "List GitHub issues",
                pluginId: "github",
                pluginActionId: "list_issues",
                pluginInput: "{\"repo\":\"bitsentry\"}",
                pluginAuth: "{\"token\":\"${globals.github_token}\"}",
              },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ ok: true, count: 1 });

    const dataMatch: unknown = expect.objectContaining({
      type: "plugin",
      sourceId: "github",
      query: "list_issues",
      body: "{\"repo\":\"bitsentry\"}",
      url: "{\"token\":\"${globals.github_token}\"}",
    });
    expect(runbookActionCreate).toHaveBeenCalledWith({ data: dataMatch });
  });
});
