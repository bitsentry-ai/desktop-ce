import { expect, it } from "vitest";
import {
  createInitialExecutionSnapshot,
  markExecutionCancelled,
} from "../src/features/runbooks";

it("cancels the step awaiting approval", () => {
  const snapshot = createInitialExecutionSnapshot({
    executionId: "execution",
    runbookId: "runbook",
    runbookRevisionNumber: 1,
    runbookTitle: "Write",
    status: "awaiting_approval",
    startedAt: "2026-10-17",
    source: "manual",
    steps: [
      {
        actionId: "write",
        order: 1,
        type: "shell",
        title: "Write",
        status: "awaiting_approval",
      },
    ],
  });
  markExecutionCancelled(snapshot, {
    completedAt: "2026-10-17",
    completionReason: "user_cancelled",
    includePendingStep: true,
  });
  expect(snapshot.steps[0].status).toBe("cancelled");
});
