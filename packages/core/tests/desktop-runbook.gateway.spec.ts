import { describe, expect, it, vi } from "vitest";

import { createDesktopRunbookGateway } from "../src/features/runbooks/desktop-runbook.gateway";
import type {
  RunbookExecutionRecord,
  RunbookRecord,
} from "../src/features/runbooks/desktop-runbook.types";

function runbook(id: string, actionCount: number): RunbookRecord {
  return {
    id,
    title: id,
    description: "",
    revisionNumber: 1,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    actions: Array.from({ length: actionCount }, (_, index) => ({
      id: `${id}-${String(index)}`,
      type: "shell",
      title: "Check service",
    })),
  };
}

describe("DesktopRunbookGateway", () => {
  it("exposes only executable runbooks and delegates a start unchanged", async () => {
    const execution = {
      executionId: "11111111-1111-4111-8111-111111111111",
      resultId: "result-1",
    };
    const start = vi.fn().mockResolvedValue(execution);
    const gateway = createDesktopRunbookGateway({
      store: {
        list: vi.fn().mockResolvedValue([
          runbook("draft", 0),
          runbook("check-api", 1),
        ]),
      },
      executionService: {
        start,
        get: vi.fn().mockResolvedValue(null as RunbookExecutionRecord | null),
        getLatestForIncidentThread: vi
          .fn()
          .mockResolvedValue(null as RunbookExecutionRecord | null),
        waitForCompletion: vi
          .fn()
          .mockResolvedValue(null as RunbookExecutionRecord | null),
        cancel: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(gateway.listExecutable()).resolves.toEqual([
      expect.objectContaining({ id: "check-api" }),
    ]);

    await expect(
      gateway.start("check-api", {
        incidentThreadId: "incident-1",
        parameterValues: { host: "api-1" },
        source: "agent",
      }),
    ).resolves.toEqual(execution);

    expect(start).toHaveBeenCalledWith("check-api", {
      incidentThreadId: "incident-1",
      parameterValues: { host: "api-1" },
      source: "agent",
    });
  });
});
