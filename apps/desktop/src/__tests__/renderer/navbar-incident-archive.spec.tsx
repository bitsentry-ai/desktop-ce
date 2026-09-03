// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import Navbar from "@bitsentry-ce/components/layout/Navbar";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({
    relativeTime: (value: string) => value,
  }),
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.navbar.archiveIncident": "Archive incident",
        "navigation.navbar.bitsentry": "BitSentry",
        "navigation.navbar.diagnosis": "Diagnosis",
        "navigation.navbar.incidents": "Incidents",
        "navigation.navbar.more": "More",
        "navigation.navbar.noIncidentsYet": "No incidents yet",
        "navigation.navbar.runbooks": "Runbooks",
        "navigation.navbar.results": "Results",
        "navigation.navbar.logOut": "Log out",
        "navigation.navbar.profile": "Profile",
        "navigation.navbar.settings": "Settings",
      })[key] ?? key,
  }),
}));

const incident = {
  id: "incident-1",
  title: "Archived after click",
  createdAt: "2026-09-03T00:00:00.000Z",
  archived: false,
  lastMessagePreview: null,
};

function createServices() {
  return {
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
    incidents: {
      listThreads: vi.fn(async () => ({ threads: [incident], total: 1 })),
      archiveThread: vi.fn(async () => ({ archived: true })),
      unarchiveThread: vi.fn(async () => ({ archived: false })),
    },
  } as never;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("bitsentry_incidents", JSON.stringify([incident]));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("Navbar incident archive synchronization", () => {
  it("persists the web archive before broadcasting the update", async () => {
    render(
      <BitsentryServicesProvider services={createServices()}>
        <MemoryRouter initialEntries={["/incidents"]}>
          <Navbar />
        </MemoryRouter>
      </BitsentryServicesProvider>,
    );

    fireEvent.click(await screen.findByTitle("Archive incident"));

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem("bitsentry_incidents") ?? "[]"))
        .toMatchObject([{ id: "incident-1", archived: true }]);
      expect(screen.queryByText("Archived after click")).toBeNull();
    });
  });
});
