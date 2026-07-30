import { describe, expect, it } from "vitest";

import { createDesktopRunbookGateway } from "../src/features/runbooks/desktop-runbook.gateway";
import type { RunbookExecutionRecord } from "../src/features/runbooks/desktop-runbook.types";

const HOUR_MS = 60 * 60 * 1000;

function execution(
  overrides: Partial<RunbookExecutionRecord> = {},
): RunbookExecutionRecord {
  const startedAt = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    executionId: "exec-old",
    runbookId: "rb-1",
    runbookTitle: "Kanye Rest",
    runbookRevisionNumber: 1,
    status: "completed",
    source: "agent",
    startedAt,
    completedAt: startedAt,
    steps: [],
    ...overrides,
  } as RunbookExecutionRecord;
}

function createGateway(previous: RunbookExecutionRecord | null) {
  const started: string[] = [];
  const gateway = createDesktopRunbookGateway({
    store: {
      list: async () => [],
      getRunbookOrThrow: async (id: string) =>
        ({
          id,
          title: "Kanye Rest",
          description: "",
          revisionNumber: 1,
          createdAt: "2026-07-04T00:00:00.000Z",
          updatedAt: "2026-07-04T00:00:00.000Z",
          actions: [{ id: "a-1", type: "shell", title: "step" }],
        }) as never,
      exportContext: async () => ({}) as never,
    },
    executionService: {
      start: async (runbookId: string) => {
        started.push(runbookId);
        return { executionId: "exec-new", resultId: "result-new" };
      },
      get: async () =>
        execution({
          executionId: "exec-new",
          status: "running",
          completedAt: undefined,
        }),
      getByRequestKey: async () =>
        previous === null
          ? null
          : { resultId: "result-old", execution: previous },
      getLatestForIncidentThread: async () => null,
      getLatestWithResultForIncidentThread: async () => null,
      waitForCompletion: async () => null,
      subscribe: () => () => undefined,
      cancel: async () => undefined,
    },
  });

  return { gateway, started };
}

describe("runbook gateway request-key deduplication", () => {
  it("starts a fresh execution instead of resurrecting a long-finished one", async () => {
    const stale = execution({
      startedAt: "2026-07-04T16:35:23.095Z",
      completedAt: "2026-07-04T16:35:39.363Z",
    });
    const { gateway, started } = createGateway(stale);

    const result = await gateway.start({
      runbookId: "rb-1",
      requestKey: "agent:session:rb-1",
      source: "agent",
    } as never);

    expect(result.deduplicated).toBe(false);
    expect(result.executionId).toBe("exec-new");
    expect(started).toEqual(["rb-1"]);
  });

  it("still deduplicates a retry of a run that is currently executing", async () => {
    const running = execution({
      executionId: "exec-old",
      status: "running",
      completedAt: undefined,
      startedAt: new Date().toISOString(),
    });
    const { gateway, started } = createGateway(running);

    const result = await gateway.start({
      runbookId: "rb-1",
      requestKey: "agent:session:rb-1",
      source: "agent",
    } as never);

    expect(result.deduplicated).toBe(true);
    expect(result.executionId).toBe("exec-old");
    expect(started).toEqual([]);
  });

  it("still deduplicates an immediate retry of a just-finished run", async () => {
    const justFinished = execution({
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      completedAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const { gateway, started } = createGateway(justFinished);

    const result = await gateway.start({
      runbookId: "rb-1",
      requestKey: "agent:session:rb-1",
      source: "agent",
    } as never);

    expect(result.deduplicated).toBe(true);
    expect(started).toEqual([]);
  });
});
