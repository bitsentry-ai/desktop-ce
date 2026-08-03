import { describe, expect, it } from "vitest";

import { RunbookExecutionService } from "../src/features/runbooks/desktop-runbook-execution.service";
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

function createHarness(): {
  service: RunbookExecutionService;
  store: FakeResultStore;
  runbook: RunbookRecord;
} {
  const store = new FakeResultStore();
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
      execute: async (_provider, _prompt, _controller, onDelta) => {
        onDelta?.({ type: "text", text: "streamed " });
        onDelta?.({ type: "text", text: "answer" });
        return { output: "streamed answer", exitCode: 0 };
      },
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
});
