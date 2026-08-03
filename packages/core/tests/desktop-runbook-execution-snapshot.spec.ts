import { describe, expect, it } from "vitest";

import {
  type LocalAiExecutionResult,
  type LocalAiStreamDelta,
  RunbookExecutionService,
} from "../src/features/runbooks/desktop-runbook-execution.service";
import type {
  ApplyExecutionSnapshotEventInput,
  ExecutionSnapshotEventOutcome,
  RunbookResultPersistence,
} from "../src/features/runbooks/desktop-runbook-result.store";
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from "../src/features/runbooks/desktop-runbook.types";

type SnapshotWrite = {
  expectedSnapshotVersion: number;
  status: RunbookExecutionRecord["status"];
};

class FakeResultStore implements RunbookResultPersistence {
  snapshot: RunbookExecutionRecord | null = null;
  writes: SnapshotWrite[] = [];
  completedControls: string[] = [];
  private journal = new Set<string>();
  private writeDelayMs = 0;
  private nextSnapshotVersion: number | null = null;
  private nextTerminalStatus: "failed" | "completed" | null = null;

  delayNextWrite(delayMs: number): void {
    this.writeDelayMs = delayMs;
  }

  advanceSnapshotVersionAfterNextRunningWrite(version: number): void {
    this.nextSnapshotVersion = version;
  }

  finalizeAfterNextRunningWrite(status: "failed" | "completed"): void {
    this.nextTerminalStatus = status;
  }

  async createRunbookResultSession(input: {
    snapshot: RunbookExecutionRecord;
  }): Promise<void> {
    this.snapshot = structuredClone(input.snapshot);
  }

  async saveExecutionSnapshot(
    _resultId: string,
    snapshot: RunbookExecutionRecord,
  ): Promise<void> {
    this.snapshot = structuredClone(snapshot);
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
    if (this.snapshot.status === "running" && this.nextSnapshotVersion !== null) {
      this.snapshot.snapshotVersion = this.nextSnapshotVersion;
      this.nextSnapshotVersion = null;
    }
    if (this.snapshot.status === "running" && this.nextTerminalStatus !== null) {
      this.snapshot.status = this.nextTerminalStatus;
      this.snapshot.completedAt = "2026-08-03T00:05:00.000Z";
      this.snapshot.errorMessage = "Execution finalized by another owner.";
      this.nextTerminalStatus = null;
    }
    return "accepted";
  }

  async getExecutionSnapshotByExecutionId(): Promise<RunbookExecutionRecord | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  async getExecutionSnapshotByResultId(): Promise<RunbookExecutionRecord | null> {
    return this.snapshot === null ? null : structuredClone(this.snapshot);
  }

  async getExecutionByRequestKey() {
    return null;
  }

  async getLatestExecutionSnapshotByIncidentThreadId() {
    return null;
  }

  async getLatestExecutionByIncidentThreadId() {
    return null;
  }

  async touchExecutionHeartbeat(): Promise<void> {}

  async requestExecutionCancellation(): Promise<boolean> {
    return false;
  }

  async isExecutionCancellationRequested(): Promise<boolean> {
    return false;
  }

  async completeExecutionControl(executionId: string): Promise<void> {
    this.completedControls.push(executionId);
  }

  async markStaleRunningSessionsFailed(): Promise<number> {
    return 0;
  }
}

type LocalAiExecute = (
  onDelta?: (delta: LocalAiStreamDelta) => void,
) => Promise<LocalAiExecutionResult>;

function createHarness(options?: { execute?: LocalAiExecute }): {
  service: RunbookExecutionService;
  store: FakeResultStore;
  runbook: RunbookRecord;
} {
  const store = new FakeResultStore();
  const execute =
    options?.execute ??
    (async (onDelta?: (delta: LocalAiStreamDelta) => void) => {
      onDelta?.({ type: "text", text: "streamed " });
      onDelta?.({ type: "text", text: "answer" });
      return { output: "streamed answer", exitCode: 0 };
    });
  const runbook: RunbookRecord = {
    id: "snapshot-runbook",
    title: "Snapshot runbook",
    description: "Streams a local AI response.",
    revisionNumber: 1,
    actions: [
      {
        id: "streaming-step",
        type: "llm",
        title: "Stream response",
        prompt: "Explain the incident.",
        llmProviderKey: "codex",
      },
    ],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
  const service = new RunbookExecutionService(
    { getRunbookOrThrow: async () => runbook } as never,
    {
      loadResolvedGlobals: async () => ({ definitions: [], values: {} }),
    } as never,
    {} as never,
    {} as never,
    store,
    () => null,
    { edition: "ce" },
    {
      execute: async (_provider, _prompt, _controller, onDelta) =>
        execute(onDelta),
    },
    {} as never,
  );
  return { service, store, runbook };
}

describe("RunbookExecutionService snapshot persistence", () => {
  it("persists ordered snapshots from public streaming execution through completion", async () => {
    const { service, store, runbook } = createHarness();
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ status: "completed", output: "streamed answer" }],
    });

    expect(store.snapshot).toMatchObject({
      executionId: started.executionId,
      status: "completed",
    });
    expect(store.writes.map((write) => write.expectedSnapshotVersion)).toEqual(
      store.writes.map((_write, index) => index + 1),
    );
    expect(store.writes.at(-1)?.status).toBe("completed");
    expect(store.completedControls).toEqual([started.executionId]);
    await service.destroy();
  });

  it("serializes a slow streaming write before the terminal snapshot", async () => {
    const { service, store, runbook } = createHarness({
      execute: async (onDelta) => {
        onDelta?.({ type: "text", text: "streamed answer" });
        store.delayNextWrite(200);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { output: "streamed answer", exitCode: 0 };
      },
    });
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({ status: "completed" });

    expect(store.snapshot).toMatchObject({
      executionId: started.executionId,
      status: "completed",
      steps: [{ status: "completed", output: "streamed answer" }],
    });
    expect(store.writes.map((write) => write.expectedSnapshotVersion)).toEqual(
      store.writes.map((_write, index) => index + 1),
    );
    expect(store.writes.map((write) => write.status).at(-1)).toBe("completed");
    await service.destroy();
  });

  it("resyncs a stale streaming version and retries the terminal snapshot", async () => {
    const { service, store, runbook } = createHarness({
      execute: async (onDelta) => {
        onDelta?.({ type: "text", text: "streamed answer" });
        store.advanceSnapshotVersionAfterNextRunningWrite(9);
        return { output: "streamed answer", exitCode: 0 };
      },
    });
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({ status: "completed" });

    expect(store.snapshot).toMatchObject({
      executionId: started.executionId,
      snapshotVersion: 10,
      status: "completed",
    });
    expect(store.writes.map((write) => write.expectedSnapshotVersion)).toContain(9);
    expect(store.writes.at(-1)?.status).toBe("completed");
    await service.destroy();
  });

  it("leaves an already-finalized persisted run untouched", async () => {
    let executionFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      executionFinished = resolve;
    });
    const { service, store, runbook } = createHarness({
      execute: async (onDelta) => {
        onDelta?.({ type: "text", text: "streamed answer" });
        store.finalizeAfterNextRunningWrite("failed");
        executionFinished?.();
        return { output: "streamed answer", exitCode: 0 };
      },
    });
    const started = await service.start(runbook.id);
    await finished;

    await expect(
      service.waitForCompletion(started.executionId, { timeoutMs: 10 }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(store.snapshot).toMatchObject({
      executionId: started.executionId,
      status: "failed",
      errorMessage: "Execution finalized by another owner.",
    });
    expect(store.writes.at(-1)?.status).toBe("running");
    expect(store.completedControls).toEqual([]);
    await service.destroy();
  });
});
