import { describe, expect, it } from "vitest";

import { createDesktopStateHandlers } from "../src/features/desktop-state/desktop-state.handlers";
import { DesktopRunbookStore } from "../src/features/runbooks/desktop-runbook.store";

type Row = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function table(rows: Row[]) {
  return {
    count: async () => rows.length,
    findMany: async (args: { where?: Record<string, unknown> } = {}) =>
      rows.filter((row) => matches(row, args.where)).map((row) => ({ ...row })),
    findUnique: async (args: { where?: Record<string, unknown> }) => {
      const row = rows.find((candidate) => matches(candidate, args.where));
      return row === undefined ? null : { ...row };
    },
    deleteMany: async (args: { where?: Record<string, unknown> } = {}) => {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (matches(rows[index], args.where)) rows.splice(index, 1);
      }
      return undefined;
    },
    create: async (args: { data: Row }) => {
      const row = { ...args.data };
      rows.push(row);
      return { ...row };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Row }) => {
      for (const row of rows) {
        if (matches(row, args.where)) Object.assign(row, args.data);
      }
      return { count: rows.filter((row) => matches(row, args.where)).length };
    },
    upsert: async (args: { where: Record<string, unknown>; update: Row; create: Row }) => {
      const existing = rows.find((row) => matches(row, args.where));
      if (existing !== undefined) {
        Object.assign(existing, args.update);
        return { ...existing };
      }

      const created = { deletedAt: null, ...args.create };
      rows.push(created);
      return { ...created };
    },
  };
}

function runbook(id: string, updatedAt: string, title = id) {
  return {
    id,
    title,
    description: "",
    revisionNumber: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt,
    actions: [{
      id: `${id}-action`,
      type: "shell",
      title: "Collect status",
      command: "systemctl status bitsentry",
    }],
  };
}

function createDb(runbooks: Row[], actions: Row[] = []) {
  const empty: Row[] = [];
  const runbookTable = table(runbooks);
  return {
    db: {
      legacyImportLedger: {
        findUnique: async () => ({ key: "phase1.localstorage.bootstrap" }),
        upsert: async () => ({}),
      },
      incidentMessage: table(empty),
      incidentThread: table(empty),
      runbook: runbookTable,
      runbookAction: table(actions),
      runbookVersion: table(empty),
      investigationSession: table(empty),
      investigationTraceEntry: table(empty),
      investigationToolRun: table(empty),
      investigationReport: table(empty),
      $queryRawUnsafe: async () => [],
      $executeRawUnsafe: async () => undefined,
    },
    runbooks,
  };
}

describe("desktopState:syncRunbooks", () => {
  it("keeps main-process runbooks that are absent from the renderer snapshot", async () => {
    const mainRunbook = { ...runbook("agent-approved", "2026-08-02T10:00:00.000Z"), deletedAt: null };
    const { db, runbooks } = createDb([mainRunbook]);
    const handlers = createDesktopStateHandlers(db as never);

    await handlers["desktopState:syncRunbooks"]({
      runbooks: [runbook("renderer-owned", "2026-08-01T10:00:00.000Z")],
    });

    expect(runbooks.map((row) => row.id).sort()).toEqual([
      "agent-approved",
      "renderer-owned",
    ]);
  });

  it("does not resurrect a runbook deleted through the runbook store", async () => {
    const deletedRunbook = { ...runbook("deleted-runbook", "2026-08-01T10:00:00.000Z"), deletedAt: null };
    const { db, runbooks } = createDb([deletedRunbook]);
    const runbookStore = new DesktopRunbookStore(db as never, {} as never);
    await runbookStore.remove({ id: "deleted-runbook" });
    expect(runbooks[0].deletedAt).toEqual(expect.any(String));

    const handlers = createDesktopStateHandlers(db as never);
    await handlers["desktopState:syncRunbooks"]({
      runbooks: [runbook("deleted-runbook", "2026-08-03T10:00:00.000Z")],
    });
    const snapshot = await handlers["desktopState:bootstrap"]({
      runbooks: [runbook("deleted-runbook", "2026-08-03T10:00:00.000Z")],
    }) as { runbooks: Array<{ id: string }> };

    expect(runbooks).toHaveLength(1);
    expect(runbooks[0].deletedAt).toEqual(expect.any(String));
    expect(snapshot.runbooks).toEqual([]);
  });

  it("keeps the newer updatedAt version when snapshots conflict", async () => {
    const current = {
      ...runbook("shared-runbook", "2026-08-03T10:00:00.000Z", "Main version"),
      deletedAt: null,
    };
    const { db, runbooks } = createDb([current]);
    const handlers = createDesktopStateHandlers(db as never);

    await handlers["desktopState:syncRunbooks"]({
      runbooks: [runbook("shared-runbook", "2026-08-02T10:00:00.000Z", "Stale renderer version")],
    });
    expect(runbooks[0].title).toBe("Main version");

    await handlers["desktopState:syncRunbooks"]({
      runbooks: [runbook("shared-runbook", "2026-08-04T10:00:00.000Z", "New renderer version")],
    });
    expect(runbooks[0]).toMatchObject({
      title: "New renderer version",
      updatedAt: "2026-08-04T10:00:00.000Z",
    });
  });
});
