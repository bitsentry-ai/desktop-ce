// @vitest-environment jsdom

import React, { Profiler, type ComponentType, type NamedExoticComponent, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { MarkdownContent } from "@bitsentry-ce/components/markdown";
import { IncidentMessageList } from "@bitsentry-ce/components/investigation/incidents/IncidentMessageList";
import IncidentsPage from "@bitsentry-ce/components/investigation/Incidents";

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

vi.mock("@bitsentry-ce/components/chat/ChatBubble", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bitsentry-ce/components/chat/ChatBubble")>();
  return { ...actual, ChatBubble: profileMemo(actual.ChatBubble, (props) => `row:${props.msg.id ?? ""}`) };
});

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

afterEach(() => {
  cleanup();
  commits.clear();
  Reflect.deleteProperty(window, "bitsentry");
});

describe("chat render counts", () => {
  it("re-renders only the streaming row", () => {
    const messages = conversation(30);
    const list = (next: ChatMessage[]) => (
      <TooltipProvider>
        <IncidentMessageList messages={next} providerKey={null} />
      </TooltipProvider>
    );
    const { rerender } = render(list(messages));
    commits.clear();

    let current = messages;
    for (let step = 1; step <= 50; step += 1) {
      current = [...current.slice(0, -1), agentMessage("m29", `answer 29${" more".repeat(step)}`)];
      rerender(list(current));
    }

    const earlier = messages.slice(0, -1).flatMap((msg) => [`row:${msg.id ?? ""}`, `row:${msg.id ?? ""}#nested`]);
    expect(earlier.filter((id) => commits.has(id))).toEqual([]);
    expect(commits.get("row:m29")).toBeLessThanOrEqual(50);
  });

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
    expect(commits.get("list")).toBeGreaterThan(0);
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
