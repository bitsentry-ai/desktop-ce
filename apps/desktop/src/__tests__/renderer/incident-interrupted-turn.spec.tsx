// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({ relativeTime: (value: string) => value }),
  useTranslation: () => ({
    t: (key: string, options?: { message?: string }) => (options?.message === undefined ? key : `${key}: ${options.message}`),
  }),
}));
// jsdom has no layout, so the virtualized list would mount no rows; this one mounts every row in order.
vi.mock("@legendapp/list/react", async () => {
  const { forwardRef } = await import("react");
  type Props = { data: ChatMessage[]; renderItem: (info: { item: ChatMessage; index: number }) => React.ReactNode };
  return {
    LegendList: forwardRef<unknown, Props>(function MountedRows({ data, renderItem }, _ref) {
      return <div>{data.map((item, index) => <div key={item.id ?? index}>{renderItem({ item, index })}</div>)}</div>;
    }),
  };
});
vi.mock("@bitsentry-ce/components/layout/Navbar", () => ({ default: () => null }));
vi.mock("@bitsentry-ce/components/layout/TopBar", () => ({ default: () => null }));

const user: ChatMessage = { id: "m1", kind: "user", text: "Why is the disk full?" };

function agentTurn(status: "streaming" | "error" | "cancelled", errorMsg?: string): ChatMessage {
  return {
    id: "m2",
    kind: "agent",
    iterations: [{ id: "i1", startedAt: "2026-11-17T00:00:00.000Z", text: "Checking the largest folders", toolCallIds: [], status: status === "streaming" ? "streaming" : "error" }],
    activeIterationId: status === "streaming" ? "i1" : null,
    toolCalls: [],
    finalText: null,
    status,
    ...(errorMsg === undefined ? {} : { errorMsg }),
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => { values.clear(); },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

/** Relaunches the desktop incidents page on a thread saved as `state`, with `messages` as its saved history. */
async function relaunch(thread: { state: string; sessionId?: string }, messages: ChatMessage[]) {
  const saveThread = vi.fn(async () => undefined);
  const appendThreadMessages = vi.fn(async () => undefined);
  Object.defineProperty(window, "bitsentry", {
    configurable: true,
    value: {
      incidents: {
        list: vi.fn(async () => [{ id: "incident-1", title: "Disk alert", createdAt: "2026-11-17T00:00:00.000Z", prompt: "", lastMessagePreview: null, ...thread }]),
        saveThread,
        getThreadMessages: vi.fn(async () => ({ messages, before: null })),
        appendThreadMessages,
      },
    },
  });
  // The incident list store and its persistence keep module state, so each relaunch gets fresh modules.
  vi.resetModules();
  const { default: IncidentsPage } = await import("@bitsentry-ce/components/investigation/Incidents");
  const { BitsentryServicesProvider } = await import("@bitsentry-ce/components/services/context");
  const { TooltipProvider } = await import("@bitsentry-ce/components/ui/tooltip");
  const { MemoryRouter } = await import("react-router-dom");
  const services = { agent: { cancel: vi.fn(), getStatus: vi.fn(async () => null), onEvent: vi.fn(() => () => undefined) } } as never;
  render(
    <BitsentryServicesProvider services={services}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/incidents?id=incident-1"]}>
          <IncidentsPage />
        </MemoryRouter>
      </TooltipProvider>
    </BitsentryServicesProvider>,
  );
  await screen.findByText("Checking the largest folders");
  return { saveThread, appendThreadMessages };
}

/** The status pill in the incident's top bar. */
function headerStatus(): string {
  const pill = document.querySelector('[data-tour="incidents-status"]');
  return pill?.textContent ?? "";
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "bitsentry");
  vi.clearAllMocks();
});

describe("a turn interrupted by closing the app", () => {
  it("shows the reply and the badge as interrupted after a relaunch, and keeps the history", async () => {
    const { saveThread, appendThreadMessages } = await relaunch({ state: "RUNNING" }, [user, agentTurn("streaming")]);

    expect(await screen.findByText("common.incidents.sessionInterrupted")).not.toBeNull();
    expect(screen.queryByText("common.incidents.sessionCancelled")).toBeNull();
    await waitFor(() => { expect(headerStatus()).toBe("common.incidents.statusInterrupted"); });
    expect(screen.getByText("Why is the disk full?")).not.toBeNull();
    expect(appendThreadMessages).not.toHaveBeenCalled();
    expect(saveThread).not.toHaveBeenCalledWith(expect.objectContaining({ state: "FAILED" }));
  });

  it("shows the same interrupted state when the saved session is gone from main", async () => {
    await relaunch({ state: "RUNNING", sessionId: "session-from-last-launch" }, [user, agentTurn("streaming")]);

    expect(await screen.findByText("common.incidents.sessionInterrupted")).not.toBeNull();
    await waitFor(() => { expect(headerStatus()).toBe("common.incidents.statusInterrupted"); });
  });

  it("shows an interrupted turn saved as failed by an earlier version as interrupted", async () => {
    await relaunch({ state: "FAILED" }, [user, agentTurn("streaming")]);

    expect(await screen.findByText("common.incidents.sessionInterrupted")).not.toBeNull();
    await waitFor(() => { expect(headerStatus()).toBe("common.incidents.statusInterrupted"); });
  });
});

describe("turns that did not end by closing the app", () => {
  it("still shows a provider error with its message and the Failed badge", async () => {
    await relaunch({ state: "FAILED" }, [user, agentTurn("error", "Provider returned 500")]);

    expect(await screen.findByText("common.incidents.errorWithMessage: Provider returned 500")).not.toBeNull();
    expect(screen.queryByText("common.incidents.sessionInterrupted")).toBeNull();
    expect(headerStatus()).toBe("common.incidentDetail.incidentFailed");
  });

  it("still shows a turn the engineer stopped as cancelled", async () => {
    await relaunch({ state: "CANCELLED" }, [user, agentTurn("cancelled", "Session cancelled by user or timeout")]);

    expect(await screen.findByText("common.incidents.sessionCancelled")).not.toBeNull();
    expect(screen.queryByText("common.incidents.sessionInterrupted")).toBeNull();
    expect(headerStatus()).toBe("common.incidentDetail.incidentCancelled");
  });
});
