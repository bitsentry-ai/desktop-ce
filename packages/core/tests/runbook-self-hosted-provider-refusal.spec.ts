import { describe, expect, it } from "vitest";

import { RunbookExecutionService } from "../src/features/runbooks/desktop-runbook-execution.service";
import type { RunbookResultPersistence } from "../src/features/runbooks/desktop-runbook-result.store";
import type {
  RunbookActionRecord,
  RunbookExecutionRecord,
  RunbookRecord,
} from "../src/features/runbooks/desktop-runbook.types";

const REFUSAL = /Self-hosted OpenAI-compatible providers run in the Dashboard/;

type Calls = {
  resultSessions: number;
  sourceQueries: number;
  local: string[];
  remote: number;
};

// An External Source step stands in for any earlier host action: its executor records whether it ran.
function makeRunbook(providerKey: RunbookActionRecord["llmProviderKey"]): RunbookRecord {
  return {
    id: "self-hosted-provider",
    title: "Self-hosted provider",
    description: "Queries a source, then asks an LLM.",
    revisionNumber: 1,
    actions: [
      {
        id: "query-step",
        type: "external_source",
        title: "Query source",
        sourceId: "source-1",
        query: "errors last hour",
      },
      {
        id: "llm-step",
        type: "llm",
        title: "Summarize",
        prompt: "Summarize the errors.",
        llmProviderKey: providerKey,
      },
    ],
    createdAt: "2026-11-18T00:00:00.000Z",
    updatedAt: "2026-11-18T00:00:00.000Z",
  };
}

function createResultStore(calls: Calls): RunbookResultPersistence {
  let snapshot: RunbookExecutionRecord | null = null;
  return {
    createRunbookResultSession: async (input) => {
      calls.resultSessions += 1;
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

function createService(runbook: RunbookRecord, defaultProviderKey: string | null) {
  const calls: Calls = { resultSessions: 0, sourceQueries: 0, local: [], remote: 0 };
  const service = new RunbookExecutionService(
    { getRunbookOrThrow: async () => runbook } as never,
    { loadResolvedGlobals: async () => ({ definitions: [], values: {} }) } as never,
    {
      chatWithTools: async () => {
        calls.remote += 1;
        return { content: "Remote result" };
      },
      getDefaultProviderKey: async () => defaultProviderKey,
    },
    {
      execute: async () => {
        calls.sourceQueries += 1;
        return "3 errors";
      },
    },
    createResultStore(calls),
    () => null,
    { edition: "ce" },
    {
      execute: async (provider) => {
        calls.local.push(provider);
        return { output: "Local result", exitCode: 0 };
      },
    },
    {} as never,
  );
  return { service, calls };
}

describe("self-hosted OpenAI-compatible provider in Desktop", () => {
  it("refuses a pinned step before the execution is recorded or any earlier step runs", async () => {
    const { service, calls } = createService(makeRunbook("openai_compatible"), "codex");

    await expect(service.start("self-hosted-provider")).rejects.toThrow(REFUSAL);

    expect(calls).toEqual({ resultSessions: 0, sourceQueries: 0, local: [], remote: 0 });
    await service.destroy();
  });

  it("fails the step instead of falling back when the inherited default is the self-hosted provider", async () => {
    const { service, calls } = createService(makeRunbook(undefined), "openai_compatible");
    const started = await service.start("self-hosted-provider");

    const finished = await service.waitForCompletion(started.executionId);

    expect(finished?.status).toBe("failed");
    expect(finished?.steps[1]?.error).toMatch(REFUSAL);
    expect(calls.local).toEqual([]);
    expect(calls.remote).toBe(0);
    await service.destroy();
  });

  it.each([
    ["an explicit Desktop provider", "codex" as const, null],
    ["an inherited Desktop provider", undefined, "claude_code"],
  ])("still runs every step with %s", async (_label, providerKey, defaultProviderKey) => {
    const { service, calls } = createService(makeRunbook(providerKey), defaultProviderKey);
    const started = await service.start("self-hosted-provider");

    await expect(service.waitForCompletion(started.executionId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(calls.resultSessions).toBe(1);
    expect(calls.sourceQueries).toBe(1);
    expect(calls.local).toEqual([providerKey ?? defaultProviderKey]);
    await service.destroy();
  });
});
