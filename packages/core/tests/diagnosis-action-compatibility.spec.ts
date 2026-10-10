import { expect, it } from "vitest";
import { exportedRunbookActionV1Schema } from "../src/features/runbooks/export.schemas";
import { runbookActionTypeSchema } from "../src/features/runbooks/runbooks.schemas";

it("exposes nine canonical action types and rejects invalid diagnosis stages", () => {
  expect(runbookActionTypeSchema.options).toHaveLength(9);
  expect(exportedRunbookActionV1Schema.safeParse({ type: "diagnosis", title: "Invalid", telemetryConfig: { stage: "unknown" } }).success).toBe(false);
});

it("rejects canonical diagnosis imports without a stage", () => {
  expect(exportedRunbookActionV1Schema.safeParse({ type: "diagnosis", title: "Incomplete" }).success).toBe(false);
});
