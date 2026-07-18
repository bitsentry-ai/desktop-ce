import { describe, expect, it } from "vitest";
import {
  OrchestrationError,
  runOrchestratedOperation,
} from "../src/features/agent-runtime/shared/effect-orchestration";

describe("runOrchestratedOperation", () => {
  it("interrupts the operation when its deadline expires", async () => {
    let wasAborted = false;

    const operation = runOrchestratedOperation({
      operation: "test operation",
      signal: new AbortController().signal,
      timeoutMs: 10,
      execute: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              wasAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });

    await expect(operation).rejects.toMatchObject<Partial<OrchestrationError>>({
      kind: "timeout",
      operation: "test operation",
    });
    expect(wasAborted).toBe(true);
  });

  it("propagates caller cancellation to the operation", async () => {
    const controller = new AbortController();
    let wasAborted = false;

    const operation = runOrchestratedOperation({
      operation: "test operation",
      signal: controller.signal,
      execute: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              wasAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });

    controller.abort();

    await expect(operation).rejects.toMatchObject<Partial<OrchestrationError>>({
      kind: "cancelled",
      operation: "test operation",
    });
    expect(wasAborted).toBe(true);
  });

  it("preserves a typed downstream failure category", async () => {
    const operation = runOrchestratedOperation({
      operation: "test operation",
      signal: new AbortController().signal,
      execute: async () => {
        throw new OrchestrationError("rate_limited", "provider request");
      },
    });

    await expect(operation).rejects.toMatchObject<Partial<OrchestrationError>>({
      kind: "rate_limited",
      operation: "provider request",
    });
  });

  it("emits a safe structured trace for a terminal operation outcome", async () => {
    const traces: Array<Record<string, unknown>> = [];

    await runOrchestratedOperation({
      operation: "provider request",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      executionId: "execution-42",
      provider: "groq",
      attempt: 2,
      onTrace: (trace) => traces.push(trace),
      execute: async () => "ok",
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]).toEqual(
      expect.objectContaining({
        operation: "provider request",
        executionId: "execution-42",
        provider: "groq",
        attempt: 2,
        timeoutMs: 1_000,
        outcome: "succeeded",
        elapsedMs: expect.any(Number),
      }),
    );
  });
});
