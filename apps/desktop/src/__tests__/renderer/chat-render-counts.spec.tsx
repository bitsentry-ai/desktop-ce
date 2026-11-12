// @vitest-environment jsdom

import React, { Profiler, useState, type ComponentType, type NamedExoticComponent, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";
import type { AgentEventPayload, AgentThreadTokenUsage, ChatMessage } from "@bitsentry-ce/components/chat/types";
import { MarkdownContent } from "@bitsentry-ce/components/markdown";
import IncidentsPage from "@bitsentry-ce/components/investigation/Incidents";
import { useIncidentListStore } from "@bitsentry-ce/components/investigation/incidents/incidentListStore";
import { useIncidentAgentEvents } from "@bitsentry-ce/components/investigation/incidents/useIncidentAgentEvents";
import type { IncidentThread } from "@bitsentry-ce/components/investigation/incidents/types";

const commits = new Map<string, number>();

/**
 * Counts Profiler commits under `id`, like T3's `counted()` helper. Follow-up commits scheduled from the subtree's own
 * layout effects are counted under `${id}#nested`.
 */
function counted(id: string, child: ReactNode) {
  return (
    <Profiler id={id} onRender={(_id, phase) => {
      const key = phase === "nested-update" ? `${id}#nested` : id;
      commits.set(key, (commits.get(key) ?? 0) + 1);
    }}>
      {child}
    </Profiler>
  );
}

/**
 * Swaps the render function inside a production `memo` for one that profiles it, so the production memo and its
 * comparison still decide whether the component renders.
 */
function profileMemo<P extends object>(component: NamedExoticComponent<P>, id: (props: P) => string) {
  const inner = (component as unknown as { type: ComponentType<P> }).type;
  const type = (props: P) => counted(id(props), React.createElement(inner, props));
  return { ...component, type } as unknown as typeof component;
}

vi.mock("@bitsentry-ce/components/investigation/incidents/IncidentMessageList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bitsentry-ce/components/investigation/incidents/IncidentMessageList")>();
  return { ...actual, IncidentMessageList: profileMemo(actual.IncidentMessageList, () => "list") };
});

// The rail is a plain child of the incidents page, so its commits count the page's own renders.
vi.mock("@bitsentry-ce/components/investigation/IncidentArtifactsRail", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bitsentry-ce/components/investigation/IncidentArtifactsRail")>();
  const Rail = actual.default;
  return { ...actual, default: (props: React.ComponentProps<typeof Rail>) => counted("page", <Rail {...props} />) };
});

vi.mock("@bitsentry-ce/components/layout/Navbar", () => ({ default: () => null }));
vi.mock("@bitsentry-ce/components/layout/TopBar", () => ({ default: () => null }));

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({ relativeTime: (value: string) => value }),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function agentMessage(id: string, text: string): ChatMessage {
  return { id, kind: "agent", iterations: [], activeIterationId: null, toolCalls: [], finalText: text, status: "done" };
}

function conversation(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? { id: `m${String(index)}`, kind: "user", text: `question ${String(index)}` } : agentMessage(`m${String(index)}`, `answer ${String(index)}`),
  );
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

function incidentRow(id: string, title: string, extra: Partial<IncidentThread> = {}): IncidentThread {
  return { id, title, createdAt: "2026-09-28T00:00:00.000Z", prompt: "", state: "IDLE", lastMessagePreview: null, ...extra };
}

/** The real navbar, which the incidents page specs above replace with a stub. */
async function renderNavbar() {
  const { default: Navbar } = await vi.importActual<typeof import("@bitsentry-ce/components/layout/Navbar")>("@bitsentry-ce/components/layout/Navbar");
  const services = {
    runtime: {
      getAuthSession: () => ({ user: { id: 1, email: "qa@example.com" }, isAuthenticated: true, isLoading: false }),
      logout: vi.fn(),
      navigate: vi.fn(),
      getConnectionStatus: () => true,
    },
    runbooks: {},
  } as never;
  render(
    <BitsentryServicesProvider services={services}>
      <MemoryRouter initialEntries={["/incidents?id=incident-1"]}>
        {counted("navbar", <Navbar />)}
      </MemoryRouter>
    </BitsentryServicesProvider>,
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  commits.clear();
}

/** The incidents page's agent event path, without the rest of the page. */
function StreamedIncident({ agent }: { agent: never }) {
  const [messagesMap, setMessagesMap] = useState<Record<string, ChatMessage[]>>({});
  const [, setTokenUsageByIncident] = useState<Record<string, AgentThreadTokenUsage>>({});
  const [, setSessionTokenUsage] = useState<AgentThreadTokenUsage | undefined>();
  useIncidentAgentEvents({ agent, activeId: "incident-1", setMessagesMap, setTokenUsageByIncident, setSessionTokenUsage });
  const last = messagesMap["incident-1"]?.at(-1);
  return <p data-testid="streamed">{last?.kind === "agent" ? last.finalText : ""}</p>;
}

afterEach(() => {
  cleanup();
  commits.clear();
  useIncidentListStore.setState({ incidents: [], loaded: false, loadedFrom: null });
  Reflect.deleteProperty(window, "bitsentry");
});

describe("chat render counts", () => {
  it("keeps the message list still while the user types", async () => {
    const storage = memoryStorage();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    storage.setItem("bitsentry_incidents", JSON.stringify([{ id: "incident-1", title: "Test incident", createdAt: "2026-09-28T00:00:00.000Z", prompt: "", state: "IDLE" }]));
    storage.setItem("bitsentry_incident_messages", JSON.stringify({ "incident-1": conversation(4) }));
    Object.defineProperty(window, "bitsentry", {
      configurable: true,
      value: { llm: { getProviders: vi.fn(async () => ({ openai: { hasApiKey: true, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", availableModels: ["gpt-4o-mini"], isSelectable: true, isPrimary: true } })) } },
    });
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
    const composer = await screen.findByPlaceholderText("common.incidents.describeTheSecurityIssueTo");
    const send = screen.getByRole("button", { name: "common.incidents.sendMessage" }) as HTMLButtonElement;
    fireEvent.change(composer, { target: { value: "x" } });
    await waitFor(() => { expect(send.disabled).toBe(false); });
    fireEvent.change(composer, { target: { value: "" } });
    // Web mode puts the stored list in the shared store from a layout effect, so the list mounts in a nested commit.
    expect((commits.get("list") ?? 0) + (commits.get("list#nested") ?? 0)).toBeGreaterThan(0);
    expect(commits.get("page")).toBeGreaterThan(0);
    commits.clear();

    const typed = "disk full on prod-db";
    for (let length = 1; length <= typed.length; length += 1) {
      fireEvent.change(composer, { target: { value: typed.slice(0, length) } });
    }

    expect((composer as HTMLTextAreaElement).value).toBe(typed);
    expect(commits.get("list") ?? 0).toBe(0);
    expect(commits.get("page") ?? 0).toBe(0);
  });

  it("re-renders the navbar only for the incident fields it shows", async () => {
    useIncidentListStore.getState().setAll([incidentRow("incident-1", "Disk alert"), incidentRow("incident-2", "Other alert")]);
    await renderNavbar();
    expect(screen.getByText("Disk alert")).not.toBeNull();

    act(() => { useIncidentListStore.getState().patch("incident-1", { sessionId: "session-1", state: "RUNNING", prompt: "why?" }); });
    expect(commits.get("navbar") ?? 0).toBe(0);

    act(() => { useIncidentListStore.getState().patch("incident-1", { title: "Disk full on prod-db" }); });
    expect(commits.get("navbar")).toBe(1);
    expect(screen.getByText("Disk full on prod-db")).not.toBeNull();
  });

  it("leaves the navbar alone while a reply streams and updates the preview when the turn settles", async () => {
    const listeners: Array<(payload: AgentEventPayload) => void> = [];
    const emit = (payload: AgentEventPayload) => { for (const listener of listeners) listener(payload); };
    const agent = { onEvent: (listener: (payload: AgentEventPayload) => void) => { listeners.push(listener); return () => undefined; }, getSnapshot: vi.fn(async () => null) } as never;
    useIncidentListStore.getState().setAll([incidentRow("incident-1", "Disk alert", { sessionId: "session-1", state: "RUNNING", lastMessagePreview: "disk full?" })]);
    render(<StreamedIncident agent={agent} />);
    await renderNavbar();

    const user: ChatMessage = { id: "u1", kind: "user", text: "disk full?" };
    const reply = (text: string, status: "streaming" | "done"): ChatMessage => ({ id: "a1", kind: "agent", iterations: [], activeIterationId: null, toolCalls: [], finalText: text, status });
    const snapshot = (sequence: number, threadState: "RUNNING" | "COMPLETED", text: string, event: unknown): AgentEventPayload => ({
      sessionId: "session-1",
      kind: "snapshot",
      sequence,
      event,
      snapshot: { sessionId: "session-1", startedAt: "2026-09-28T00:00:00.000Z", runtimeState: threadState, threadState, currentToolCallId: null, messages: [user, reply(text, threadState === "RUNNING" ? "streaming" : "done")] },
    });
    act(() => { emit(snapshot(1, "RUNNING", "", { type: "tool_start" })); });
    for (let step = 1; step <= 20; step += 1) {
      act(() => {
        emit({ sessionId: "session-1", kind: "message", sequence: 1 + step, messageCount: 2, messageIndex: 1, message: reply(`checking${" disk".repeat(step)}`, "streaming"), threadState: "RUNNING", runtimeState: "RUNNING", currentToolCallId: null });
      });
    }

    expect(screen.getByTestId("streamed").textContent).toBe(`checking${" disk".repeat(20)}`);
    expect(commits.get("navbar") ?? 0).toBe(0);
    expect(within(screen.getByRole("navigation")).getByText("disk full?")).not.toBeNull();

    act(() => { emit(snapshot(22, "COMPLETED", "The disk is full.", { type: "final" })); });
    expect(commits.get("navbar")).toBe(1);
    expect(within(screen.getByRole("navigation")).getByText("The disk is full.")).not.toBeNull();
  });

  it("retries the desktop list on the next visit after a failed load", async () => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
    const list = vi.fn().mockRejectedValueOnce(new Error("database busy")).mockResolvedValue([incidentRow("incident-9", "Main incident")]);
    Object.defineProperty(window, "bitsentry", {
      configurable: true,
      value: { incidents: { list, saveThread: vi.fn(async () => undefined), getThreadMessages: vi.fn(async () => []), appendThreadMessages: vi.fn(async () => undefined) } },
    });
    const services = { agent: { cancel: vi.fn(), getStatus: vi.fn(async () => null), onEvent: vi.fn(() => () => undefined) } } as never;
    const page = () => (
      <BitsentryServicesProvider services={services}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/incidents?view=history"]}>
            <IncidentsPage />
          </MemoryRouter>
        </TooltipProvider>
      </BitsentryServicesProvider>
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = render(page());
    await waitFor(() => { expect(list).toHaveBeenCalledTimes(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    first.unmount();

    render(page());

    expect(await screen.findByText("Main incident")).not.toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("saves a metadata change made while only the navbar is mounted", async () => {
    const saveThread = vi.fn(async () => undefined);
    Object.defineProperty(window, "bitsentry", {
      configurable: true,
      value: { incidents: { list: vi.fn(async () => [incidentRow("incident-1", "Disk alert")]), saveThread } },
    });
    // The navbar reads desktop mode once at import, so load fresh modules after the desktop API exists.
    vi.resetModules();
    const { default: Navbar } = await vi.importActual<typeof import("@bitsentry-ce/components/layout/Navbar")>("@bitsentry-ce/components/layout/Navbar");
    const { BitsentryServicesProvider: Provider } = await import("@bitsentry-ce/components/services/context");
    const { useIncidentListStore: store } = await import("@bitsentry-ce/components/investigation/incidents/incidentListStore");
    const { MemoryRouter: Router } = await import("react-router-dom");
    const services = {
      runtime: {
        getAuthSession: () => ({ user: { id: 1, email: "qa@example.com" }, isAuthenticated: true, isLoading: false }),
        logout: vi.fn(),
        navigate: vi.fn(),
        getConnectionStatus: () => true,
      },
      runbooks: {},
    } as never;
    render(
      <Provider services={services}>
        <Router initialEntries={["/incidents"]}>
          <Navbar />
        </Router>
      </Provider>,
    );
    expect(await screen.findByText("Disk alert")).not.toBeNull();

    act(() => { store.getState().patch("incident-1", { sessionId: "session-9" }); });

    await waitFor(() => { expect(saveThread).toHaveBeenCalledWith({ id: "incident-1", sessionId: "session-9" }); });
    expect(saveThread).toHaveBeenCalledTimes(1);
  });

  it("keeps a code block mounted when the markdown re-renders", () => {
    const content = "Run this:\n\n```sh\ndf -h\n```";
    const { container, rerender } = render(<MarkdownContent content={content} className="a" />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();

    rerender(<MarkdownContent content={content} className="b" />);

    expect(container.querySelector("pre")).toBe(pre);
    expect(pre?.isConnected).toBe(true);
  });
});
