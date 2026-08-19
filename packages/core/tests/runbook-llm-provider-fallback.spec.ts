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

type Dispatch = {
  local: Array<{ provider: string; model: string | undefined }>;
  remote: number;
  requestedModels: Array<string | undefined>;
};

function makeRunbook(model?: string, providerKey?: RunbookRecord["actions"][number]["llmProviderKey"]): RunbookRecord {
  return {
    id: "provider-fallback",
    title: "Provider fallback",
    description: "Runs one provider-less LLM action.",
    revisionNumber: 1,
    actions: [
      {
        id: "llm-step",
        type: "llm",
        title: "Summarize",
        prompt: "Summarize the incident.",
        llmProviderKey: providerKey,
        llmModel: model,
      },
    ],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

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

function createService(
  defaultProviderKey: string | null,
  runbook: RunbookRecord,
): { service: RunbookExecutionService; dispatch: Dispatch } {
  const dispatch: Dispatch = { local: [], remote: 0, requestedModels: [] };
  const localResult: LocalAiExecutionResult = {
    output: "Local provider result",
    exitCode: 0,
  };
  const service = new RunbookExecutionService(
    { getRunbookOrThrow: async () => runbook } as never,
    {
      loadResolvedGlobals: async () => ({ definitions: [], values: {} }),
    } as never,
    {
      chatWithTools: async () => {
        dispatch.remote += 1;
        return { content: "Remote provider result" };
      },
      getDefaultProviderKey: async (model?: string) => {
        dispatch.requestedModels.push(model);
        return defaultProviderKey;
      },
    },
    {} as never,
    createResultStore(),
    () => null,
    { edition: "ce" },
    {
      execute: async (
        provider,
        _prompt,
        _abortController,
        _onDelta,
        _cwd,
        model,
      ) => {
        dispatch.local.push({ provider, model });
        return localResult;
      },
    },
    {} as never,
  );

  return { service, dispatch };
}

describe("runbook LLM action provider fallback", () => {
  it("runs provider-less actions through the configured local provider", async () => {
    const runbook = makeRunbook();
    const { service, dispatch } = createService("codex", runbook);
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ output: "Local provider result" }],
    });
    expect(dispatch.local).toEqual([{ provider: "codex", model: undefined }]);
    expect(dispatch.remote).toBe(0);
    await service.destroy();
  });

  it("passes the action model into configured-provider resolution", async () => {
    const runbook = makeRunbook("claude-sonnet-4-6");
    const { service, dispatch } = createService("claude_code", runbook);
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ output: "Local provider result" }],
    });
    expect(dispatch.requestedModels).toEqual(["claude-sonnet-4-6"]);
    expect(dispatch.local).toEqual([
      { provider: "claude_code", model: "claude-sonnet-4-6" },
    ]);
    await service.destroy();
  });

  it("normalizes a legacy friendly model name before local execution", async () => {
    const runbook = makeRunbook("GPT 5.6 Terra", "codex");
    const { service, dispatch } = createService("codex", runbook);
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ output: "Local provider result" }],
    });
    expect(dispatch.local).toEqual([
      { provider: "codex", model: "gpt-5.6-terra" },
    ]);
    await service.destroy();
  });

  it("uses the remote path when no default provider is configured", async () => {
    const runbook = makeRunbook();
    const { service, dispatch } = createService(null, runbook);
    const started = await service.start(runbook.id);

    await expect(
      service.waitForCompletion(started.executionId),
    ).resolves.toMatchObject({
      status: "completed",
      steps: [{ output: "Remote provider result" }],
    });
    expect(dispatch.local).toEqual([]);
    expect(dispatch.remote).toBe(1);
    await service.destroy();
  });
});
