// @vitest-environment jsdom

import React, { act } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopStateBootstrap } from "@bitsentry-ce/components/desktop/DesktopStateBootstrapRuntime";

const mockIpcInvoke = vi.fn();

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@bitsentry-ce/components/desktop/DesktopIpcRuntime", () => ({
  ipcInvoke: (...args: unknown[]): unknown => mockIpcInvoke(...args) as unknown,
}));

vi.mock("@bitsentry-ce/components/desktop/DesktopPosthogRenderer", () => ({
  captureDesktopAnalyticsEvent: () => {},
}));

type RunbookExecutionEvent = {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: {
    executionId: string;
    runbookId: string;
    runbookTitle: string;
    status: "running" | "completed" | "failed" | "cancelled";
    startedAt: string;
    completedAt?: string;
    completionReason?:
      | "success"
      | "step_failed"
      | "user_cancelled"
      | "idle_timeout"
      | "app_shutdown"
      | "lease_expired";
    steps: Array<{
      actionId: string;
      order: number;
      type: "shell" | "llm" | "http" | "external_source";
      title: string;
      status: "pending" | "running" | "completed" | "failed" | "cancelled";
    }>;
  };
};

let executionCallback:
  | ((event: RunbookExecutionEvent) => void)
  | undefined;
let runbookChangeCallback: (() => void) | undefined;

beforeEach(() => {
  mockIpcInvoke.mockReset();
  executionCallback = undefined;
  runbookChangeCallback = undefined;
  localStorage.clear();
  Object.defineProperty(window, "bitsentry", {
    configurable: true,
    value: {
      runbooks: {
        onExecutionEvent: (callback: (event: RunbookExecutionEvent) => void) => {
          executionCallback = callback;
          return () => {
            executionCallback = undefined;
          };
        },
        onChanged: (callback: () => void) => {
          runbookChangeCallback = callback;
          return () => {
            runbookChangeCallback = undefined;
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  Reflect.deleteProperty(window, "bitsentry");
});

describe("DesktopStateBootstrap", () => {
  it("refreshes the mirrored runbook snapshot after a main-process mutation", async () => {
    localStorage.setItem(
      "bitsentry_runbooks",
      JSON.stringify([{ id: "stale-runbook" }]),
    );
    let bootstrapCalls = 0;
    mockIpcInvoke.mockImplementation((channel: string) => {
      if (channel === "desktopState:bootstrap") {
        bootstrapCalls += 1;
        return Promise.resolve({
          incidents: [],
          incidentMessages: {},
          runbooks: bootstrapCalls === 1
            ? [{ id: "server-runbook" }]
            : [{ id: "server-runbook" }, { id: "agent-approved" }],
          results: [],
          resultTraces: {},
        });
      }
      if (channel === "desktopState:syncRunbooks") return Promise.resolve();
      if (channel === "desktopState:syncResults") return Promise.resolve();
      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(
      <DesktopStateBootstrap>
        <div>workspace-ready</div>
      </DesktopStateBootstrap>,
    );
    await waitFor(() => expect(screen.getByText("workspace-ready")).toBeTruthy());
    await waitFor(() => expect(runbookChangeCallback).toBeTypeOf("function"));

    act(() => {
      runbookChangeCallback?.();
    });
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("bitsentry_runbooks") ?? "[]")).toEqual([
        { id: "server-runbook" },
        { id: "agent-approved" },
      ]);
    });

  });

  it("hydrates local state from the desktop bridge and mirrors execution events into storage", async () => {
    localStorage.setItem(
      "bitsentry_runbooks",
      JSON.stringify([{ id: "local-runbook" }]),
    );
    localStorage.setItem(
      "bitsentry_results",
      JSON.stringify([{ id: "existing-result", runbookTitle: "Old" }]),
    );
    localStorage.setItem(
      "bitsentry_result_traces",
      JSON.stringify({ "existing-result": { execution: null } }),
    );

    mockIpcInvoke.mockImplementation((channel: string) => {
      if (channel === "desktopState:bootstrap") {
        return Promise.resolve({
          incidents: [{ id: "incident-1" }],
          incidentMessages: { "incident-1": [{ id: "message-1" }] },
          runbooks: [{ id: "server-runbook" }],
          results: [],
          resultTraces: {},
        });
      }

      if (channel === "desktopState:syncRunbooks") {
        return Promise.resolve();
      }

      if (channel === "desktopState:syncResults") {
        return Promise.resolve();
      }

      throw new Error(`Unexpected channel: ${channel}`);
    });

    render(
      <DesktopStateBootstrap>
        <div>workspace-ready</div>
      </DesktopStateBootstrap>,
    );

    expect(
      screen.getByText("common.desktopStateBootstrap.loadingWorkspace"),
    ).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("workspace-ready")).toBeTruthy();
    });

    expect(mockIpcInvoke).toHaveBeenCalledWith("desktopState:bootstrap", {
      incidents: [],
      incidentMessages: {},
      runbooks: [{ id: "local-runbook" }],
      results: [{ id: "existing-result", runbookTitle: "Old" }],
      resultTraces: { "existing-result": { execution: null } },
    });
    expect(JSON.parse(localStorage.getItem("bitsentry_runbooks") ?? "[]")).toEqual(
      [{ id: "server-runbook" }],
    );
    expect(JSON.parse(localStorage.getItem("bitsentry_results") ?? "[]")).toEqual(
      [],
    );

    await waitFor(() => {
      expect(executionCallback).toBeTypeOf("function");
    });

    act(() => {
      executionCallback?.({
        resultId: "result-1",
        executionId: "exec-1",
        incidentThreadId: "incident-1",
        execution: {
          executionId: "exec-1",
          runbookId: "runbook-1",
          runbookTitle: "Collect journal",
          status: "running",
          startedAt: "2026-05-06T12:00:00.000Z",
          steps: [
            {
              actionId: "step-1",
              order: 0,
              type: "shell",
              title: "Read journalctl",
              status: "running",
            },
          ],
        },
      });
    });

    const storedResults: unknown = JSON.parse(
      localStorage.getItem("bitsentry_results") ?? "[]",
    );
    const storedTraces: unknown = JSON.parse(
      localStorage.getItem("bitsentry_result_traces") ?? "{}",
    );

    expect(storedResults).toEqual([
      {
        id: "result-1",
        executionId: "exec-1",
        incidentThreadId: "incident-1",
        runbookId: "runbook-1",
        runbookTitle: "Collect journal",
        status: "running",
        startedAt: "2026-05-06T12:00:00.000Z",
      },
    ]);
    expect(storedTraces).toEqual({
      "result-1": {
        execution: {
          executionId: "exec-1",
          runbookId: "runbook-1",
          runbookTitle: "Collect journal",
          status: "running",
          startedAt: "2026-05-06T12:00:00.000Z",
          steps: [
            {
              actionId: "step-1",
              order: 0,
              type: "shell",
              title: "Read journalctl",
              status: "running",
            },
          ],
        },
      },
    });

    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(
      mockIpcInvoke.mock.calls.filter(
        ([channel]) => channel === "desktopState:syncResults",
      ),
    ).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event("bitsentry:results-updated"));
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });

    expect(
      mockIpcInvoke.mock.calls.filter(
        ([channel]) => channel === "desktopState:syncResults",
      ),
    ).toHaveLength(1);
    vi.useRealTimers();
  });
});
