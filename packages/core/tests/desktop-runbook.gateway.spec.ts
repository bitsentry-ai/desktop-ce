import { describe, expect, it } from "vitest";

import { createDesktopRunbookGateway } from "../src/features/runbooks/desktop-runbook.gateway";
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from "../src/features/runbooks/desktop-runbook.types";

function runbook(
  id: string,
  actionCount: number,
  revisionNumber = 1,
): RunbookRecord {
  return {
    id,
    title: id,
    description: "",
    revisionNumber,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    actions: Array.from({ length: actionCount }, (_, index) => ({
      id: `${id}-${String(index)}`,
      type: "shell",
      title: "Check service",
    })),
  };
}

class InMemoryExecutionService {
  constructor(private readonly revisions: Record<string, number> = {}) {}

  private readonly executions = new Map<
    string,
    { resultId: string; requestKey?: string; execution: RunbookExecutionRecord }
  >();
  private readonly listeners = new Set<
    (event: {
      resultId: string;
      executionId: string;
      incidentThreadId?: string | null;
      execution: RunbookExecutionRecord;
    }) => void
  >();

  async start(
    runbookId: string,
    options?: {
      incidentThreadId?: string;
      requestKey?: string;
      source?: "manual" | "agent";
    },
  ): Promise<{ executionId: string; resultId: string }> {
    const executionId = `execution-${String(this.executions.size + 1)}`;
    const resultId = `result-${String(this.executions.size + 1)}`;
    const execution: RunbookExecutionRecord = {
      executionId,
      runbookId,
      runbookRevisionNumber: this.revisions[runbookId] ?? 1,
      incidentThreadId: options?.incidentThreadId,
      runbookTitle: runbookId,
      status: "running",
      snapshotVersion: 1,
      startedAt: "2026-07-30T00:00:00.000Z",
      source: options?.source ?? "manual",
      steps: [],
    };
    this.executions.set(executionId, {
      resultId,
      requestKey: options?.requestKey,
      execution,
    });
    for (const listener of this.listeners) {
      listener({
        resultId,
        executionId,
        incidentThreadId: options?.incidentThreadId,
        execution,
      });
    }
    return { executionId, resultId };
  }

  async get(executionId: string): Promise<RunbookExecutionRecord | null> {
    return this.executions.get(executionId)?.execution ?? null;
  }

  async getLatestForIncidentThread(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null> {
    return (
      [...this.executions.values()]
        .map((entry) => entry.execution)
        .find((execution) => execution.incidentThreadId === incidentThreadId) ??
      null
    );
  }

  async getLatestWithResultForIncidentThread(incidentThreadId: string) {
    const match = [...this.executions.values()].find(
      (entry) => entry.execution.incidentThreadId === incidentThreadId,
    );
    return match === undefined
      ? null
      : { resultId: match.resultId, execution: match.execution };
  }

  async getByRequestKey(runbookId: string, requestKey: string) {
    const match = [...this.executions.values()].find(
      (entry) =>
        entry.execution.runbookId === runbookId && entry.requestKey === requestKey,
    );
    return match === undefined
      ? null
      : { resultId: match.resultId, execution: match.execution };
  }

  async waitForCompletion(executionId: string) {
    return this.get(executionId);
  }

  subscribe(
    listener: (event: {
      resultId: string;
      executionId: string;
      incidentThreadId?: string | null;
      execution: RunbookExecutionRecord;
    }) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async cancel(): Promise<void> {}
}

describe("DesktopRunbookGateway", () => {
  it("lists executable runbooks and starts one immutable selected revision", async () => {
    const runbooks = [runbook("draft", 0), runbook("check-api", 1, 4)];
    const executionService = new InMemoryExecutionService({ "check-api": 4 });
    const gateway = createDesktopRunbookGateway({
      store: {
        list: async () => runbooks,
        getRunbookOrThrow: async (id) => {
          const selected = runbooks.find((item) => item.id === id);
          if (selected === undefined) throw new Error("Runbook not found");
          return selected;
        },
      },
      executionService,
    });

    await expect(gateway.listExecutable()).resolves.toEqual([
      expect.objectContaining({ id: "check-api" }),
    ]);

    const accepted = await gateway.start({
      runbookId: "check-api",
      expectedRevisionNumber: 4,
      requestKey: "incident-1:run-check-api",
      incidentId: "incident-1",
      parameterValues: { host: "api-1" },
      source: "agent",
    });

    expect(accepted).toMatchObject({
      deduplicated: false,
      runbook: { id: "check-api", revisionNumber: 4 },
      execution: {
        executionId: accepted.executionId,
        runbookRevisionNumber: 4,
        incidentThreadId: "incident-1",
        status: "running",
      },
    });

    runbooks[1] = runbook("check-api", 1, 5);
    await expect(gateway.get(accepted.executionId)).resolves.toMatchObject({
      runbookRevisionNumber: 4,
    });
  });

  it("replays one accepted execution for a request key and publishes it to the incident", async () => {
    const runbooks = [runbook("check-api", 1)];
    const executionService = new InMemoryExecutionService();
    const gateway = createDesktopRunbookGateway({
      store: {
        list: async () => runbooks,
        getRunbookOrThrow: async () => runbooks[0]!,
      },
      executionService,
    });
    const events: string[] = [];
    const unsubscribe = gateway.subscribe("incident-1", (event) => {
      events.push(event.executionId);
    });

    const request = {
      runbookId: "check-api",
      requestKey: "incident-1:run-check-api",
      incidentId: "incident-1",
      source: "agent" as const,
    };
    const first = await gateway.start(request);
    const replay = await gateway.start(request);
    await Promise.resolve();
    unsubscribe();

    expect(replay).toMatchObject({
      executionId: first.executionId,
      resultId: first.resultId,
      deduplicated: true,
    });
    expect(events).toContain(first.executionId);
  });

  it("rejects stale selections and malformed execution requests before a run starts", async () => {
    const current = runbook("check-api", 1, 2);
    const gateway = createDesktopRunbookGateway({
      store: {
        list: async () => [current],
        getRunbookOrThrow: async () => current,
      },
      executionService: new InMemoryExecutionService(),
    });

    await expect(
      gateway.start({
        runbookId: "check-api",
        expectedRevisionNumber: 1,
        requestKey: "incident-1:stale-selection",
        source: "agent",
      }),
    ).rejects.toThrow("changed from revision 1 to 2");
    await expect(
      gateway.start({
        runbookId: "check-api",
        requestKey: "",
        source: "agent",
      }),
    ).rejects.toThrow();
  });
});
