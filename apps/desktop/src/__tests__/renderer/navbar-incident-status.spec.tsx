// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Navbar from "@bitsentry-ce/components/layout/Navbar";
import { notifyIncidentAttentionChanged } from "@bitsentry-ce/components/layout/incident-nav-status";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({
    relativeTime: (value: string) => value,
  }),
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "navigation.navbar.incidents": "Incidents",
        "navigation.navbar.incidentStatus.completed": "Completed",
        "navigation.navbar.incidentStatus.failed": "Failed",
        "navigation.navbar.incidentStatus.needsInput": "Needs your input",
        "navigation.navbar.incidentStatus.working": "Working",
      })[key] ?? key,
  }),
}));

type AgentEventHandler = (data: { sessionId: string; event: unknown; snapshot?: { threadState: string } }) => void;

function createServices(listProposals: () => Promise<unknown[]>) {
  const handlers: AgentEventHandler[] = [];
  const services = {
    runtime: {
      getAuthSession: () => ({
        user: { id: 1, email: "qa@example.com" },
        isAuthenticated: true,
        isLoading: false,
      }),
      logout: vi.fn(),
      navigate: vi.fn(),
      getConnectionStatus: () => true,
    },
    runbooks: {} as never,
    agent: {
      listRunbookAuthoringProposals: vi.fn(listProposals),
      onEvent: (handler: AgentEventHandler) => {
        handlers.push(handler);
        return () => {};
      },
    },
  } as never;
  const emit = (sessionId: string, threadState: string) => {
    act(() => handlers.forEach((handler) => handler({ sessionId, event: {}, snapshot: { threadState } })));
  };
  return { services, emit };
}

function renderNavbar(path: string, services: never) {
  return render(
    <BitsentryServicesProvider services={services}>
      <MemoryRouter initialEntries={[path]}>
        <Navbar />
      </MemoryRouter>
    </BitsentryServicesProvider>,
  );
}

function storeIncidents(incidents: Array<Record<string, unknown>>) {
  localStorage.setItem(
    "bitsentry_incidents",
    JSON.stringify(incidents.map((incident) => ({ createdAt: "2026-10-01T00:00:00.000Z", ...incident }))),
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Navbar incident status", () => {
  it("shows a finished run until the engineer opens the incident", async () => {
    storeIncidents([
      { id: "disk", title: "Disk full", state: "RUNNING", sessionId: "session-disk" },
      { id: "other", title: "Other incident", state: "IDLE" },
    ]);
    const { services, emit } = createServices(async () => []);
    renderNavbar("/incidents?id=other", services);

    expect(await screen.findByRole("img", { name: "Working" })).toBeTruthy();

    emit("session-disk", "COMPLETED");
    expect(await screen.findByRole("img", { name: "Completed" })).toBeTruthy();

    fireEvent.click(screen.getByText("Disk full"));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Completed" })).toBeNull());
  });

  it("asks for input while a runbook draft waits for approval", async () => {
    storeIncidents([{ id: "disk", title: "Disk full", state: "COMPLETED" }]);
    let proposals = [{ isLatest: true, status: "pending_approval" }];
    const { services } = createServices(async () => proposals);
    renderNavbar("/incidents", services);

    expect(await screen.findByText("Needs your input")).toBeTruthy();

    proposals = [{ isLatest: true, status: "approved" }];
    act(() => notifyIncidentAttentionChanged());
    await waitFor(() => expect(screen.queryByText("Needs your input")).toBeNull());
  });
});
