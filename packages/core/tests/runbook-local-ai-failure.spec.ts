import { describe, expect, it } from "vitest";

import {
  RunbookExecutionService,
  type LocalAiExecutionResult,
} from "../src/features/runbooks/desktop-runbook-execution.service";
import type { RunbookResultPersistence } from "../src/features/runbooks/desktop-runbook-result.store";
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from "../src/features/runbooks/desktop-runbook.types";

function createResultStore(): RunbookResultPersistence {
  let snapshot: RunbookExecutionRecord | null = null;
  return {
    createRunbookResultSession: async (input) => {
      snapshot = structuredClone(input.snapshot);
    },
    saveExecutionSnapshot: async (_resultId, nextSnapshot) => {
      snapshot = structuredClone(nextSnapshot);
    },
    applyExecutionSnapshotEvent: async (_resultId, input) => {
      snapshot = structuredClone(input.snapshot);
      return "accepted";
    },
    getExecutionSnapshotByExecutionId: async () =>
      snapshot === null ? null : structuredClone(snapshot),
    getExecutionSnapshotByResultId: async () =>
      snapshot === null ? null : structuredClone(snapshot),
    getExecutionByRequestKey: async () => null,
    getLatestExecutionSnapshotByIncidentThreadId: async () => null,
    getLatestExecutionByIncidentThreadId: async () => null,
    touchExecutionHeartbeat: async () => {},
    requestExecutionCancellation: async () => false,
    isExecutionCancellationRequested: async () => false,
    completeExecutionControl: async () => {},
    markStaleRunningSessionsFailed: async () => 0,
  };
}

async function executeLocalAiStep(
  result: LocalAiExecutionResult,
): Promise<RunbookExecutionRecord | null> {
  const runbook: RunbookRecord = {
    id: "local-ai-failure",
    title: "Local AI failure",
    description: "Runs one local AI action.",
    revisionNumber: 1,
    actions: [
      {
        id: "local-ai-step",
        type: "llm",
        title: "Diagnose",
        prompt: "Diagnose the incident.",
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
    createResultStore(),
    () => null,
    { edition: "ce" },
    { execute: async () => result },
    {} as never,
  );
  const started = await service.start(runbook.id);
  const execution = await service.waitForCompletion(started.executionId);
  await service.destroy();
  return execution;
}

describe("local AI step failure reporting", () => {
  it("fails the execution when the provider returns nothing", async () => {
    await expect(executeLocalAiStep({ output: "" })).resolves.toMatchObject({
      status: "failed",
      steps: [{ error: expect.stringMatching(/did not produce a result/) }],
    });
  });

  it("surfaces provider error text in the failed execution", async () => {
    await expect(
      executeLocalAiStep({
        output: "",
        error: "Not inside a trusted directory",
      }),
    ).resolves.toMatchObject({
      status: "failed",
      steps: [
        { error: expect.stringMatching(/Not inside a trusted directory/) },
      ],
    });
  });

  it("reports a non-zero local provider exit code", async () => {
    await expect(
      executeLocalAiStep({ output: "", exitCode: 1 }),
    ).resolves.toMatchObject({
      status: "failed",
      steps: [{ error: expect.stringMatching(/exit code 1/) }],
    });
  });

  it("completes the run when the local provider produces output", async () => {
    await expect(
      executeLocalAiStep({ output: "a real answer", exitCode: 0 }),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ output: "a real answer" }],
    });
  });
});
