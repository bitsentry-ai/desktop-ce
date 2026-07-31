import { describe, expect, it } from "vitest";

import { createDesktopStateHandlers } from "../src/features/desktop-state/desktop-state.handlers";

type Row = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function table(rows: Row[]) {
  return {
    count: async () => rows.length,
    findMany: async () => rows.map((row) => ({ ...row })),
    findUnique: async (args: { where?: Record<string, unknown> }) => {
      const row = rows.find((candidate) => matches(candidate, args.where));
      return row === undefined ? null : { ...row };
    },
    deleteMany: async (args: Record<string, unknown>) => {
      const where = args.where as Record<string, unknown> | undefined;
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], where)) {
          rows.splice(index, 1);
        }
      }
      return undefined;
    },
    create: async (args: { data: Row }) => {
      rows.push({ ...args.data });
      return args.data;
    },
  };
}

function createDb(sessions: Row[]) {
  const empty: Row[] = [];
  return {
    db: {
      legacyImportLedger: {
        findUnique: async () => null,
        upsert: async () => ({}),
      },
      incidentMessage: table(empty),
      incidentThread: table(empty),
      runbook: table(empty),
      runbookAction: table(empty),
      runbookVersion: table(empty),
      investigationSession: table(sessions),
      investigationTraceEntry: table([]),
      investigationToolRun: table([]),
      investigationReport: table([]),
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async () => undefined,
    },
    sessions,
  };
}

describe("desktopState:syncResults ownership", () => {
  it("never overwrites an execution-backed row with the renderer mirror", async () => {
    const sessions: Row[] = [
      {
        id: "result-1",
        executionId: "exec-1",
        runbookId: "rb-1",
        runbookTitle: "Kanye Rest",
        status: "completed",
        startedAt: "2026-07-30T19:17:59.002Z",
        completedAt: "2026-07-30T19:18:20.000Z",
        executionSnapshotJson: JSON.stringify({ status: "completed" }),
      },
    ];
    const { db } = createDb(sessions);
    const handlers = createDesktopStateHandlers(db as never);
    const syncResults = handlers["desktopState:syncResults"];

    // The renderer mirror still believes the run is going and carries a
    // completion timestamp from an unrelated older run.
    await syncResults({
      results: [
        {
          id: "result-1",
          executionId: "exec-1",
          runbookId: "rb-1",
          runbookTitle: "Kanye Rest",
          status: "running",
          startedAt: "2026-07-30T19:17:59.002Z",
          completedAt: "2026-07-04T16:35:39.363Z",
        },
      ],
      resultTraces: {},
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("completed");
    expect(sessions[0].completedAt).toBe("2026-07-30T19:18:20.000Z");
    expect(sessions[0].executionSnapshotJson).toBe(
      JSON.stringify({ status: "completed" }),
    );
  });

  it("keeps execution history the renderer mirror no longer holds", async () => {
    const sessions: Row[] = [
      {
        id: "result-old",
        executionId: "exec-old",
        runbookId: "rb-1",
        runbookTitle: "Kanye Rest",
        status: "completed",
        startedAt: "2026-07-04T16:35:23.095Z",
      },
    ];
    const { db } = createDb(sessions);
    const handlers = createDesktopStateHandlers(db as never);
    const syncResults = handlers["desktopState:syncResults"];

    await syncResults({ results: [], resultTraces: {} });

    expect(sessions.map((row) => row.id)).toEqual(["result-old"]);
  });

  it("still stores renderer-owned rows that have no execution", async () => {
    const sessions: Row[] = [];
    const { db } = createDb(sessions);
    const handlers = createDesktopStateHandlers(db as never);
    const syncResults = handlers["desktopState:syncResults"];

    await syncResults({
      results: [
        {
          id: "local-1",
          runbookId: "rb-1",
          runbookTitle: "Kanye Rest",
          status: "running",
          startedAt: "2026-07-30T19:17:59.002Z",
        },
      ],
      resultTraces: {},
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("local-1");
  });
});
