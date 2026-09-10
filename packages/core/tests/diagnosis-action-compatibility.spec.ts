import { expect, it } from "vitest";
import { exportedRunbookActionV1Schema } from "../src/features/runbooks/export.schemas";
import { runbookActionTypeSchema } from "../src/features/runbooks/runbooks.schemas";

it.each(["diagnose", "verify", "recommend"] as const)("imports legacy diagnosis_%s without losing its stage or IDs", (stage) => {
  const imported = exportedRunbookActionV1Schema.parse({
    type: `diagnosis_${stage}`, title: "Legacy diagnosis", telemetryConfig: { telemetryEntryIds: [42] },
  });
  expect(imported.type).toBe("diagnosis");
  expect(imported.telemetryConfig).toEqual({ stage, telemetryEntryIds: [42] });
  expect(exportedRunbookActionV1Schema.parse(imported)).toEqual(imported);
  expect(runbookActionTypeSchema.safeParse(`diagnosis_${stage}`).success).toBe(false);
});

it("exposes nine canonical action types and rejects invalid diagnosis stages", () => {
  expect(runbookActionTypeSchema.options).toHaveLength(9);
  expect(exportedRunbookActionV1Schema.safeParse({ type: "diagnosis", title: "Invalid", telemetryConfig: { stage: "unknown" } }).success).toBe(false);
});

it("rejects canonical diagnosis imports without a stage", () => {
  expect(exportedRunbookActionV1Schema.safeParse({ type: "diagnosis", title: "Incomplete" }).success).toBe(false);
});
