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
  investigationSessionCreate: ReturnType<typeof vi.fn>;
  investigationSessionDeleteMany: ReturnType<typeof vi.fn>;
  investigationSessionFindUnique: ReturnType<typeof vi.fn>;
} {
  const runbookActionCreate = vi.fn().mockResolvedValue({});
  const investigationSessionCreate = vi.fn().mockResolvedValue({});
  const investigationSessionDeleteMany = vi.fn().mockResolvedValue({});
  const investigationSessionFindUnique = vi.fn().mockResolvedValue(null);
  const runbookAction = {
    ...createNoopTable(),
    create: runbookActionCreate,
  };
  const investigationSession = {
    ...createNoopTable(),
    create: investigationSessionCreate,
    deleteMany: investigationSessionDeleteMany,
    findUnique: investigationSessionFindUnique,
  };
  const db = {
    legacyImportLedger: createNoopTable(),
    incidentMessage: createNoopTable(),
    incidentThread: createNoopTable(),
    runbook: createNoopTable(),
    runbookAction,
    runbookVersion: createNoopTable(),
    investigationSession,
    investigationTraceEntry: createNoopTable(),
    investigationToolRun: createNoopTable(),
    investigationReport: createNoopTable(),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };

  const dbHandle: unknown = db;
  return {
    db: dbHandle as DesktopStateDatabase,
    runbookActionCreate,
    investigationSessionCreate,
    investigationSessionDeleteMany,
    investigationSessionFindUnique,
  };
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

  it.each(["running", "completed"] as const)(
    "does not replace a main-process-owned %s execution with renderer cache",
    async (status) => {
      const {
        db,
        investigationSessionCreate,
        investigationSessionDeleteMany,
        investigationSessionFindUnique,
      } = createDesktopStateDatabase();
      investigationSessionFindUnique.mockResolvedValue({
        id: "result-1",
        executionId: "execution-1",
        status,
        executionSnapshotJson: JSON.stringify({
          executionId: "execution-1",
          status,
        }),
      });
      const handlers = createDesktopStateHandlers(db);

      await expect(
        handlers["desktopState:syncResults"]({
          results: [
            {
              id: "result-1",
              executionId: "execution-1",
              runbookId: "runbook-1",
              runbookTitle: "Sentry Desktop Error Check",
              status: "running",
              startedAt: "2026-07-31T00:22:26.394Z",
              prompt: "",
            },
          ],
          resultTraces: {
            "result-1": {
              execution: {
                executionId: "execution-1",
                status: "running",
              },
            },
          },
        }),
      ).resolves.toEqual({ ok: true, count: 1 });

      expect(investigationSessionFindUnique).toHaveBeenCalledWith({
        where: { id: "result-1" },
      });
      expect(investigationSessionDeleteMany).not.toHaveBeenCalled();
      expect(investigationSessionCreate).not.toHaveBeenCalled();
    },
  );
});
