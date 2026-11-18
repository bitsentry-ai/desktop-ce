import { describe, expect, it, vi } from "vitest";
import {
  DesktopJobRuntime,
  type DesktopJobRuntimeDatabase,
} from "../src/features/jobs/desktop-job-runtime";

function harness() {
  const row: Record<string, unknown> = {
    id: "job-1",
    type: "test",
    status: "queued",
    attempt: 0,
    maxAttempts: 1,
    timeoutMs: 10000,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const table = {
    create: async () => row,
    findUnique: async () => ({ ...row }),
    update: async ({ data }: { data: Record<string, unknown> }) =>
      Object.assign(row, data),
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      const matches = Object.entries(where).every(([key, value]) => {
        if (value !== null && typeof value === "object" && "in" in value)
          return (value.in as unknown[]).includes(row[key]);
        return row[key] === value;
      });
      if (matches) Object.assign(row, data);
      return { count: matches ? 1 : 0 };
    },
    findMany: async () => [row],
    findFirst: async () => row,
    upsert: async () => row,
  };
  const db: DesktopJobRuntimeDatabase = { jobRun: table, jobSchedule: table };
  const runtime = new DesktopJobRuntime(db, {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cron: { validate: () => true, schedule: () => ({ stop: () => {} }) },
  });
  const execute = () =>
    (
      runtime as unknown as {
        executeJob(row: Record<string, unknown>): Promise<void>;
      }
    ).executeJob({ ...row });
  return { row, runtime, execute };
}

function settleOnAbort(settle: "resolve" | "reject") {
  const state = { started: false, finished: false };
  const handler = async (_payload: unknown, signal: AbortSignal) => {
    state.started = true;
    await new Promise((resolve) => { signal.addEventListener("abort", resolve, { once: true }); });
    await new Promise((resolve) => setTimeout(resolve, 50));
    state.finished = true;
    if (settle === "reject") throw signal.reason;
    return "done";
  };
  return { state, handler };
}

describe("desktop job state races", () => {
  it("does not requeue a job claimed while a retry request was awaiting its read", async () => {
    const { row, runtime } = harness();
    row.status = "failed";
    const retry = runtime.retry("job-1");
    row.status = "running";
    row.attempt = 1;
    await retry;
    expect(row.status).toBe("running");
    expect(row.attempt).toBe(1);
  });

  it("keeps cancellation when a handler ignores abort and returns successfully", async () => {
    const { row, runtime, execute } = harness();
    let finish!: (result: unknown) => void;
    runtime.registerHandler(
      "test",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = execute();
    await Promise.resolve();
    await Promise.resolve();
    await runtime.cancel("job-1");
    finish("late success");
    await running;
    expect(row.status).toBe("cancelled");
  });

  it("does not execute the same queued job twice during overlapping ticks", async () => {
    const { row, runtime, execute } = harness();
    let finish!: (result: unknown) => void;
    const handler = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    runtime.registerHandler("test", handler);
    const first = execute();
    const second = execute();
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledOnce();
    finish("done");
    await Promise.all([first, second]);
    expect(row.status).toBe("completed");
    expect(row.attempt).toBe(1);
  });

  it("stop() waits for a running handler and re-queues it", async () => {
    const { row, runtime, execute } = harness();
    const { state, handler } = settleOnAbort("reject");
    runtime.registerHandler("test", handler);
    void execute();
    await vi.waitFor(() => expect(state.started).toBe(true));
    await runtime.stop();
    expect(state.finished).toBe(true);
    expect(row.status).toBe("queued");
    expect(row.attempt).toBe(0);
  });

  it("a handler that resolves after the shutdown abort is completed, not re-queued", async () => {
    const { row, runtime, execute } = harness();
    const { state, handler } = settleOnAbort("resolve");
    runtime.registerHandler("test", handler);
    void execute();
    await vi.waitFor(() => expect(state.started).toBe(true));
    await runtime.stop();
    expect(row.status).toBe("completed");
    expect(row.attempt).toBe(1);
  });

  it("does not start a job already cancelled by another runtime", async () => {
    const { row, runtime, execute } = harness();
    row.status = "cancelled";
    const handler = vi.fn();
    runtime.registerHandler("test", handler);
    await execute();
    expect(handler).not.toHaveBeenCalled();
    expect(row.status).toBe("cancelled");
  });
});
