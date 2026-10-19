import "@bitsentry-ce/components/desktop/desktop-index.css";
import React, { createRef, Profiler, type ComponentType, type NamedExoticComponent, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { LegendListRef } from "@legendapp/list/react";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { IncidentMessageList } from "@bitsentry-ce/components/investigation/incidents/IncidentMessageList";

const commits = new Map<string, number>();

/** Counts each row's commits; follow-ups scheduled from the row's own layout effects count under `${id}#nested`. */
vi.mock("@bitsentry-ce/components/chat/ChatBubble", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bitsentry-ce/components/chat/ChatBubble")>();
  const component = actual.ChatBubble as unknown as NamedExoticComponent<{ msg: ChatMessage }> & { type: ComponentType<{ msg: ChatMessage }> };
  const inner = component.type;
  const type = (props: { msg: ChatMessage }): ReactNode => {
    const id = `row:${props.msg.id ?? ""}`;
    return (
      <Profiler id={id} onRender={(_id, phase) => {
        const key = phase === "nested-update" ? `${id}#nested` : id;
        commits.set(key, (commits.get(key) ?? 0) + 1);
      }}>
        {React.createElement(inner, props)}
      </Profiler>
    );
  };
  return { ...actual, ChatBubble: { ...component, type } };
});

vi.mock("@bitsentry-ce/i18n", () => ({
  useFormatters: () => ({ relativeTime: (value: string) => value }),
  useTranslation: () => ({ t: (key: string) => key }),
}));

function agentMessage(id: string, text: string): ChatMessage {
  return { id, kind: "agent", iterations: [], activeIterationId: null, toolCalls: [], finalText: text, status: "done" };
}

/** Alternating questions and answers; every seventh answer is several paragraphs long. */
function conversation(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index): ChatMessage => {
    const id = `m${String(index)}`;
    if (index % 2 === 0) return { id, kind: "user", text: `question ${String(index)}` };
    const long = index % 7 === 0 ? `\n\n${"The disk on prod-db filled up overnight. ".repeat(30)}`.repeat(3) : "";
    return agentMessage(id, `answer ${String(index)}${long}`);
  });
}

/** Replaces the last message with a longer copy, like a streaming reply. */
function grow(messages: ChatMessage[], step: number): ChatMessage[] {
  const last = messages.at(-1);
  const id = last?.id ?? "last";
  return [...messages.slice(0, -1), agentMessage(id, `streamed ${id} step ${String(step)}\n\n${"More output from the agent. ".repeat(step * 6)}`)];
}

function mountList(initial: ChatMessage[], height = 600) {
  const listRef = createRef<LegendListRef>();
  const onAtEndChange = vi.fn();
  const view = (messages: ChatMessage[]) => (
    <TooltipProvider>
      <div style={{ position: "relative", height, width: 800 }}>
        <IncidentMessageList messages={messages} providerKey={null} listRef={listRef} headerClassName="h-6" onAtEndChange={onAtEndChange} />
      </div>
    </TooltipProvider>
  );
  const { rerender } = render(view(initial));
  return {
    listRef,
    viewport: () => {
      const node = listRef.current?.getScrollableNode();
      if (node === undefined) throw new Error("list not mounted");
      return node;
    },
    rerender: (messages: ChatMessage[]) => { rerender(view(messages)); },
  };
}

const mountedRows = () => document.querySelectorAll("[data-message-id]");
const rowFor = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
const atBottom = (viewport: HTMLElement) => viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2;
const nextFrame = () => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve(); }); });

/** Waits until rows mounted by a scroll are measured and the offset holds for three frames. */
async function settle(viewport: HTMLElement) {
  await act(async () => {
    let still = 0;
    let last = Number.NaN;
    while (still < 3) {
      await nextFrame();
      still = viewport.scrollTop === last ? still + 1 : 0;
      last = viewport.scrollTop;
    }
  });
}

async function scrollTo(viewport: HTMLElement, top: number) {
  viewport.scrollTop = top;
  await settle(viewport);
}

/** Scrolls like a reader, with the mouse wheel. */
async function wheel(viewport: HTMLElement, deltaY: number) {
  await userEvent.wheel(viewport, { delta: { y: deltaY } });
  await settle(viewport);
}

/** Rerenders with a longer last message and waits until the new text is laid out. */
async function streamStep(list: ReturnType<typeof mountList>, messages: ChatMessage[], step: number) {
  const next = grow(messages, step);
  list.rerender(next);
  const id = next.at(-1)?.id ?? "";
  await vi.waitFor(() => { expect(rowFor(id)?.textContent).toContain(`step ${String(step)}`); });
  await act(nextFrame);
  return next;
}

afterEach(() => {
  cleanup();
  commits.clear();
});

describe("incident message list", () => {
  it("mounts only the rows around the viewport", async () => {
    const messages = conversation(500);
    const list = mountList(messages);
    await vi.waitFor(() => { expect(rowFor("m499")).not.toBeNull(); });
    await vi.waitFor(() => { expect(atBottom(list.viewport())).toBe(true); });

    const mounted = mountedRows().length;
    console.info(`mounted rows for 500 messages: ${String(mounted)}`);
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(60);
  });

  it("re-renders only the streaming row", async () => {
    const messages = conversation(30);
    // Tall enough that every row stays mounted, so the counts cover all 30 rows.
    const list = mountList(messages, 4000);
    await vi.waitFor(() => { expect(mountedRows()).toHaveLength(30); });
    await act(nextFrame);
    commits.clear();

    let current = messages;
    for (let step = 1; step <= 50; step += 1) {
      current = [...current.slice(0, -1), agentMessage("m29", `answer 29${" more".repeat(step)}`)];
      list.rerender(current);
    }
    await vi.waitFor(() => { expect(rowFor("m29")?.textContent).toContain(`answer 29${" more".repeat(50)}`); });

    const earlier = messages.slice(0, -1).flatMap((msg) => [`row:${msg.id ?? ""}`, `row:${msg.id ?? ""}#nested`]);
    expect(earlier.filter((id) => commits.has(id))).toEqual([]);
    // The list hands rows their new item from a layout effect, so a row's commits are nested updates. At most one
    // commit per update means the copy button keeps its props and the tooltip trigger never re-commits on its own.
    const streamed = (commits.get("row:m29") ?? 0) + (commits.get("row:m29#nested") ?? 0);
    expect(streamed).toBeGreaterThan(0);
    expect(streamed).toBeLessThanOrEqual(50);
  });

  it("stays pinned to the newest output while a reply streams", async () => {
    let messages = conversation(60);
    const list = mountList(messages);
    await vi.waitFor(() => { expect(atBottom(list.viewport())).toBe(true); });

    for (let step = 1; step <= 20; step += 1) {
      messages = await streamStep(list, messages, step);
      await expect.poll(() => atBottom(list.viewport())).toBe(true);
    }
  });

  it("stops following when the reader scrolls up and resumes at the end", async () => {
    let messages = conversation(60);
    const list = mountList(messages);
    const viewport = list.viewport();
    await vi.waitFor(() => { expect(atBottom(viewport)).toBe(true); });
    messages = await streamStep(list, messages, 1);

    await wheel(viewport, -600);
    await vi.waitFor(() => { expect(list.listRef.current?.getState().isAtEnd).toBe(false); });
    const readingAt = viewport.scrollTop;
    messages = await streamStep(list, messages, 2);
    await act(nextFrame);
    expect(viewport.scrollTop).toBe(readingAt);
    expect(atBottom(viewport)).toBe(false);

    await wheel(viewport, viewport.scrollHeight);
    await vi.waitFor(() => { expect(list.listRef.current?.getState().isAtEnd).toBe(true); });
    await streamStep(list, messages, 3);
    await expect.poll(() => atBottom(viewport)).toBe(true);
  });

  it("resumes following when the reader returns to the end after a small scroll up", async () => {
    let messages = conversation(60);
    const list = mountList(messages);
    const viewport = list.viewport();
    await vi.waitFor(() => { expect(atBottom(viewport)).toBe(true); });
    messages = await streamStep(list, messages, 1);

    await wheel(viewport, -20);
    expect(atBottom(viewport)).toBe(false);
    await wheel(viewport, 100);
    expect(atBottom(viewport)).toBe(true);
    for (let step = 2; step <= 5; step += 1) {
      messages = await streamStep(list, messages, step);
      await expect.poll(() => atBottom(viewport)).toBe(true);
    }
  });

  it("keeps the first visible row in place when a row above it grows", async () => {
    const messages = conversation(120);
    const list = mountList(messages);
    const viewport = list.viewport();
    await vi.waitFor(() => { expect(atBottom(viewport)).toBe(true); });
    await scrollTo(viewport, viewport.scrollHeight / 2);

    const top = () => viewport.getBoundingClientRect().top;
    const rows = () => [...mountedRows()] as HTMLElement[];
    // A mounted row entirely above the viewport, and the first row inside it.
    const above = rows().filter((row) => row.getBoundingClientRect().bottom < top()).at(-1);
    const anchor = rows().find((row) => row.getBoundingClientRect().top >= top());
    const aboveId = above?.dataset.messageId ?? "";
    const anchorId = anchor?.dataset.messageId ?? "";
    expect(aboveId).not.toBe("");
    expect(anchorId).not.toBe("");
    const offset = () => (rowFor(anchorId)?.getBoundingClientRect().top ?? Number.NaN) - top();
    const before = offset();
    const aboveHeight = above?.getBoundingClientRect().height ?? 0;

    const longer = "Much longer now. ".repeat(200);
    list.rerender(messages.map((msg) => (msg.id !== aboveId ? msg : msg.kind === "user" ? { ...msg, text: longer } : agentMessage(aboveId, longer))));
    await vi.waitFor(() => { expect(rowFor(aboveId)?.getBoundingClientRect().height).toBeGreaterThan(aboveHeight + 100); });
    await act(nextFrame);

    expect(Math.abs(offset() - before)).toBeLessThanOrEqual(2);
  });

  it("keeps a failed tool card's details open when its row scrolls out and back", async () => {
    const failed: ChatMessage = {
      id: "m1",
      kind: "agent",
      iterations: [{ id: "i1", startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:01Z", text: "", toolCallIds: ["tc1"], status: "done" }],
      activeIterationId: null,
      toolCalls: [{ toolCallId: "tc1", toolName: "ssh_exec", state: "failed", error: JSON.stringify({ code: "INVALID_INPUT", message: "The host is missing.", issues: [{ path: "host", message: "Required" }] }) }],
      finalText: null,
      status: "done",
    };
    const list = mountList(conversation(120).map((msg) => (msg.id === "m1" ? failed : msg)));
    const viewport = list.viewport();
    await vi.waitFor(() => { expect(atBottom(viewport)).toBe(true); });
    // Scrolls to the top until the failed row is mounted; rows measured late can still move the offset.
    const detailsAtTop = () => vi.waitFor(() => {
      viewport.scrollTop = 0;
      const found = rowFor("m1")?.querySelector("details");
      if (found === null || found === undefined) throw new Error("failed tool card not mounted");
      return found;
    });

    const details = await detailsAtTop();
    const summary = details.querySelector("summary");
    if (summary === null) throw new Error("details summary not rendered");
    await userEvent.click(summary);
    await vi.waitFor(() => { expect(rowFor("m1")?.querySelector("details")?.open).toBe(true); });

    await scrollTo(viewport, viewport.scrollHeight);
    await vi.waitFor(() => { expect(rowFor("m1")).toBeNull(); });
    expect((await detailsAtTop()).open).toBe(true);
  });
});
