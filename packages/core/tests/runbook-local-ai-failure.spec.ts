import { describe, expect, it } from "vitest";

import { RunbookExecutionService } from "../src/features/runbooks/desktop-runbook-execution.service";
import type { LocalAiExecutionResult } from "../src/features/runbooks/desktop-runbook-execution.service";

function assertSucceeded(
  result: Partial<LocalAiExecutionResult>,
  output: string,
): void {
  const service = new RunbookExecutionService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    () => null,
    { edition: "ce" },
    undefined,
    {} as never,
  );

  (
    service as unknown as {
      assertLocalAiStepSucceeded(
        providerKey: string,
        result: Partial<LocalAiExecutionResult>,
        output: string,
      ): void;
    }
  ).assertLocalAiStepSucceeded("codex", result, output);
}

describe("local AI step failure reporting", () => {
  it("fails the step when the provider returns nothing", () => {
    expect(() => {
      assertSucceeded({ output: "" }, "");
    }).toThrow(/did not produce a result/);
  });

  it("surfaces the provider error text so the real cause is visible", () => {
    expect(() => {
      assertSucceeded(
        { output: "", error: "Not inside a trusted directory" },
        "",
      );
    }).toThrow(/Not inside a trusted directory/);
  });

  it("reports a non-zero exit code", () => {
    expect(() => {
      assertSucceeded({ output: "", exitCode: 1 }, "");
    }).toThrow(/exit code 1/);
  });

  it("accepts a normal successful run", () => {
    expect(() => {
      assertSucceeded({ output: "a real answer", exitCode: 0 }, "a real answer");
    }).not.toThrow();
  });
});
