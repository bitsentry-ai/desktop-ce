import { describe, expect, it } from "vitest";

import { RunbookExecutionService } from "../src/features/runbooks/desktop-runbook-execution.service";
import {
  createExecutionSessionState,
  markExecutionCompleted,
} from "../src/features/runbooks/execution";
import type {
  ApplyExecutionSnapshotEventInput,
  ExecutionSnapshotEventOutcome,
  RunbookResultPersistence,
} from "../src/features/runbooks/desktop-runbook-result.store";
import type { RunbookExecutionRecord } from "../src/features/runbooks/desktop-runbook.types";

type SnapshotWrite = {
  expectedSnapshotVersion: number;
  status: RunbookExecutionRecord["status"];
};

class FakeResultStore implements Partial<RunbookResultPersistence> {
  snapshot: RunbookExecutionRecord | null = null;
  writes: SnapshotWrite[] = [];
  completedControls: string[] = [];
  private journal = new Set<string>();
  private writeDelayMs = 0;

  seed(snapshot: RunbookExecutionRecord): void {
    this.snapshot = structuredClone(snapshot);
  }

  delayNextWrite(delayMs: number): void {
    this.writeDelayMs = delayMs;
  }

  async applyExecutionSnapshotEvent(
    _resultId: string,
    input: ApplyExecutionSnapshotEventInput,
  ): Promise<ExecutionSnapshotEventOutcome> {
    const delay = this.writeDelayMs;
    this.writeDelayMs = 0;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (this.journal.has(input.eventId)) {
      return "duplicate";
    }
    const current = this.snapshot;
    if (
      current === null ||
      current.snapshotVersion !== input.expectedSnapshotVersion ||
      (current.status !== "running" && current.status !== input.snapshot.status)
    ) {
      return "stale";
    }
    this.snapshot = structuredClone(input.snapshot);
    this.journal.add(input.eventId);
    this.writes.push({
      expectedSnapshotVersion: input.expectedSnapshotVersion,
      status: input.snapshot.status,
    });
    return "accepted";
  }

  async getExecutionSnapshotByResultId(): Promise<RunbookExecutionRecord | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  async completeExecutionControl(executionId: string): Promise<void> {
    this.completedControls.push(executionId);
  }
}

function createHarness(): {
  service: RunbookExecutionService;
  store: FakeResultStore;
  session: Record<string, unknown>;
  events: RunbookExecutionRecord[];
} {
  const store = new FakeResultStore();
  const service = new RunbookExecutionService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    store as unknown as RunbookResultPersistence,
    () => null,
    { edition: "ce" },
    undefined,
    {} as never,
  );

  const state = createExecutionSessionState({
    executionId: "exec-1",
    runbookId: "rb-1",
    runbookRevisionNumber: 1,
    runbookTitle: "Race repro",
    status: "running",
    startedAt: new Date().toISOString(),
    parameterValues: {},
    source: "manual",
    actions: [{ id: "a-1", type: "shell", title: "step" }],
    parameterDefinitions: [],
    globals: {},
    globalDefinitions: [],
  });
  state.snapshot.snapshotVersion = 0;
  store.seed(state.snapshot);

  const session = {
    resultId: "result-1",
    parameterValues: state.parameterValues,
    redactedParameterValues: state.redactedParameterValues,
    secureParameterKeys: state.secureParameterKeys,
    globals: {},
    globalDefinitions: [],
    secureGlobalKeys: state.secureGlobalKeys,
    redactor: state.redactor,
    snapshot: state.snapshot,
    abortController: new AbortController(),
  };

  const events: RunbookExecutionRecord[] = [];
  service.subscribe((payload) => {
    events.push(payload.execution);
  });

  return { service, store, session, events };
}

function emit(
  service: RunbookExecutionService,
  session: Record<string, unknown>,
): Promise<void> {
  return (
    service as unknown as {
      emitSnapshot(session: unknown): Promise<void>;
    }
  ).emitSnapshot(session);
}

describe("RunbookExecutionService snapshot persistence", () => {
  it("serializes concurrent emits so a slow streaming write cannot outrace the terminal write", async () => {
    const { service, store, session, events } = createHarness();

    // Streaming emit whose store write is slow, immediately followed by the
    // terminal emit. Before serialization the terminal write reached the
    // store first, was rejected as stale, and the run stayed "running".
    store.delayNextWrite(20);
    const streaming = emit(service, session);
    markExecutionCompleted(
      (session as { snapshot: RunbookExecutionRecord }).snapshot,
      new Date().toISOString(),
    );
    const terminal = emit(service, session);
    await Promise.all([streaming, terminal]);

    expect(store.snapshot?.status).toBe("completed");
    expect(
      store.writes.map((write) => write.expectedSnapshotVersion),
    ).toEqual([0, 1]);
    expect(store.completedControls).toEqual(["exec-1"]);
    expect(events.at(-1)?.status).toBe("completed");
  });

  it("resyncs a diverged snapshot version and retries the terminal write", async () => {
    const { service, store, session, events } = createHarness();

    // Simulate a previously dropped write: the in-memory version is ahead
    // of the persisted one, which used to reject every later write.
    (session as { snapshot: RunbookExecutionRecord }).snapshot.snapshotVersion = 5;
    markExecutionCompleted(
      (session as { snapshot: RunbookExecutionRecord }).snapshot,
      new Date().toISOString(),
    );
    await emit(service, session);

    expect(store.snapshot?.status).toBe("completed");
    expect(store.completedControls).toEqual(["exec-1"]);
    expect(events.at(-1)?.status).toBe("completed");
  });

  it("leaves a store-side terminal state untouched when the persisted run was already finalized", async () => {
    const { service, store, session } = createHarness();

    store.snapshot = {
      ...structuredClone(
        (session as { snapshot: RunbookExecutionRecord }).snapshot,
      ),
      status: "failed",
      snapshotVersion: 9,
    };
    markExecutionCompleted(
      (session as { snapshot: RunbookExecutionRecord }).snapshot,
      new Date().toISOString(),
    );
    await emit(service, session);

    expect(store.snapshot.status).toBe("failed");
    expect(store.completedControls).toEqual([]);
  });
});
