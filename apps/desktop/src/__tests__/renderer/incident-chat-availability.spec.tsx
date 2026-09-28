// @vitest-environment jsdom

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";
import IncidentsPage from "@bitsentry-ce/components/investigation/Incidents";

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({ relativeTime: (value: string) => value }),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@bitsentry-ce/components/layout/Navbar", () => ({
  default: () => null,
}));

vi.mock("@bitsentry-ce/components/layout/TopBar", () => ({
  default: () => null,
}));

const incident = {
  id: "incident-1",
  title: "Test incident",
  createdAt: "2026-09-28T00:00:00.000Z",
  prompt: "",
  state: "IDLE",
  archived: false,
};

const provider = {
  openai: {
    hasApiKey: true,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    availableModels: ["gpt-4o-mini"],
    isSelectable: true,
    isPrimary: true,
  },
};

function createStorage() {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function renderIncidents(path: string) {
  const services = {
    agent: {
      start: vi.fn(async () => ({ sessionId: "session-1" })),
      send: vi.fn(async () => ({ sessionId: "session-1" })),
      cancel: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => null),
      onEvent: vi.fn(() => () => undefined),
    },
  } as never;

  return render(
    <BitsentryServicesProvider services={services}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <IncidentsPage />
        </MemoryRouter>
      </TooltipProvider>
    </BitsentryServicesProvider>,
  );
}

beforeEach(() => {
  const storage = createStorage();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  window.localStorage.clear();
  window.localStorage.setItem(
    "bitsentry_incidents",
    JSON.stringify([incident]),
  );
  Object.defineProperty(window, "bitsentry", {
    configurable: true,
    value: { llm: { getProviders: vi.fn(async () => provider) } },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "bitsentry");
  vi.clearAllMocks();
});

describe("incident chat availability", () => {
  it("lets a configured provider start a chat with no saved runbooks", async () => {
    renderIncidents("/incidents?id=incident-1");

    const composer = await screen.findByPlaceholderText(
      "common.incidents.describeTheSecurityIssueTo",
    );
    fireEvent.change(composer, { target: { value: "Start a conversation" } });

    expect(
      (
        screen.getByRole("button", {
          name: "common.incidents.sendMessage",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.queryByText("common.incidents.noValidRunbookFound"),
    ).toBeNull();
  });

  it("keeps the composer blocked when no provider is configured", async () => {
    const desktopWindow = window as typeof window & {
      bitsentry?: {
        llm?: { getProviders: () => Promise<Record<string, never>> };
      };
    };
    desktopWindow.bitsentry!.llm!.getProviders = vi.fn(async () => ({}));
    renderIncidents("/incidents?id=incident-1");

    await waitFor(() => {
      expect(
        (
          screen.getByRole("button", {
            name: "common.incidents.sendMessage",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    });
    expect(screen.getByText("common.incidents.addAnApiKeyIn")).toBeTruthy();
  });

  it("keeps archived incidents locked and offers the unarchive control", async () => {
    window.localStorage.setItem(
      "bitsentry_incidents",
      JSON.stringify([{ ...incident, archived: true }]),
    );
    renderIncidents("/incidents?view=history&id=incident-1");

    expect(
      (
        (await screen.findByRole("button", {
          name: "common.incidents.unarchiveIncident",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Test incident",
        }) as HTMLButtonElement
      ).getAttribute("title"),
    ).toBe("common.incidents.archivedIncidentsAreReadOnly");
    expect(
      screen.queryByPlaceholderText(
        "common.incidents.describeTheSecurityIssueTo",
      ),
    ).toBeNull();
  });
});
