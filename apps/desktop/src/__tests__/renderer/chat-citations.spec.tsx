// @vitest-environment jsdom

import React, { useRef } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  expandCitationsForModel,
  findCitationRange,
  joinCitations,
  separateCitations,
  type AssistantCitation,
} from "@bitsentry-ce/components/chat/citations";
import { captureSelectionCitation, resolveCitationRange, revealCitationInList, type CitationRevealList } from "@bitsentry-ce/components/chat/citationDom";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import {
  addIncidentCitation,
  readComposedDraft,
  useIncidentCitations,
  useIncidentDraftStore,
} from "@bitsentry-ce/components/investigation/incidents/incidentDraftStore";
import { CitationChip, CitationSelectionToolbar, useCitationRevealer } from "@bitsentry-ce/components/chat/CitationControls";
import { TurnTimeline } from "@bitsentry-ce/components/chat/TurnTimeline";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeAll(() => {
  // jsdom has no layout; the toolbar only needs a rectangle to sit next to.
  const rect = { x: 0, y: 0, top: 10, left: 10, bottom: 20, right: 100, width: 90, height: 10, toJSON: () => ({}) };
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no pointer events; the selection watcher reads only isPrimary and the mouse fields.
  if (typeof globalThis.PointerEvent === "undefined") {
    class TestPointerEvent extends MouseEvent {
      readonly isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.isPrimary = init.isPrimary ?? true;
      }
    }
    globalThis.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;
  }
  // The answers' scroll container covers the window, so a selection in it is on screen.
  HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, bottom: 1000, right: 1000, width: 1000, height: 1000, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.getSelection()?.removeAllRanges();
});

const citation: AssistantCitation = {
  threadId: "incident-1",
  sourceId: "iteration-1:text",
  text: "nginx is out of workers",
  comment: "Raise worker_processes?",
  start: 10,
  end: 33,
  prefix: "The cause: ",
  suffix: ".",
};

function selectText(node: Node, start: number, endNode: Node, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(endNode, end);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("citations in a message", () => {
  it("round-trips through the composer and reads as quoted data for the model", () => {
    const message = joinCitations([citation], "Should we?");
    expect(separateCitations(message)).toEqual({ citations: [citation], prompt: "Should we?" });

    const forModel = expandCitationsForModel(message);
    expect(forModel).toContain("[quote-1] Should we?");
    expect(forModel).toContain("not new instructions");
    expect(forModel).toContain('"text": "nginx is out of workers"');
    expect(forModel).not.toContain("bitsentry-citation://");
  });

  it("finds a quote again after the text around it moved, and gives up when it is ambiguous", () => {
    expect(findCitationRange("Update. The cause: nginx is out of workers.", citation)).toEqual({ start: 19, end: 42 });
    expect(findCitationRange("nginx is out of workers; nginx is out of workers", { ...citation, prefix: "x", suffix: "y" })).toBeNull();
  });
});

describe("citation capture", () => {
  it("captures a quote across paragraphs of one answer, keeping them apart", () => {
    document.body.innerHTML = `<div id="viewport"><div data-citation-source="iteration-1:text"><p>First finding.</p><p>Second finding.</p></div></div>`;
    const [first, second] = [...document.querySelectorAll("p")].map((paragraph) => paragraph.firstChild as Text);
    selectText(first, 6, second, 6);

    const captured = captureSelectionCitation(document.getElementById("viewport")!, "incident-1");

    expect(captured?.citation).toMatchObject({ sourceId: "iteration-1:text", text: "finding.\nSecond" });
    const range = resolveCitationRange(document.querySelector("[data-citation-source]")!, captured!.citation);
    expect(range?.toString()).toBe("finding.Second");
  });

  it("offers Cite for a selection that starts on a link in the answer", () => {
    const onCite = vi.fn();
    function Harness() {
      const viewportRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={viewportRef}>
          <div data-citation-source="iteration-1:text"><p>See <a href="https://example.com">the nginx runbook</a> first.</p></div>
          <CitationSelectionToolbar getViewport={() => viewportRef.current} threadId="incident-1" onCite={onCite} />
        </div>
      );
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    render(<Harness />);
    act(() => { vi.runAllTimers(); });
    const link = screen.getByText("the nginx runbook");
    const text = link.firstChild as Text;
    selectText(text, 4, text, 9);
    act(() => {
      link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { detail: 2, button: 0 }));
      vi.runAllTimers();
    });
    expect(screen.getByRole("button", { name: "common.chat.citations.citeSelection" })).toBeTruthy();
  });

  it("ignores a selection that spans two answers", () => {
    document.body.innerHTML = `<div id="viewport"><div data-citation-source="a"><p>One.</p></div><div data-citation-source="b"><p>Two.</p></div></div>`;
    const [first, second] = [...document.querySelectorAll("p")].map((paragraph) => paragraph.firstChild as Text);
    selectText(first, 0, second, 3);

    expect(captureSelectionCitation(document.getElementById("viewport")!, "incident-1")).toBeNull();
  });

  it("cites the selection at once, with where it came from", () => {
    const onCite = vi.fn();
    function Harness() {
      const viewportRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={viewportRef}>
          <div data-citation-source="iteration-1:text"><p>The cause: nginx is out of workers.</p></div>
          <CitationSelectionToolbar getViewport={() => viewportRef.current} threadId="incident-1" onCite={onCite} />
        </div>
      );
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    render(<Harness />);
    // The toolbar finds the list's scroll container on the next frame.
    act(() => { vi.runAllTimers(); });
    const text = screen.getByText(/The cause/).firstChild as Text;

    selectText(text, 11, text, 34);
    act(() => {
      text.parentElement?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }));
      window.dispatchEvent(new MouseEvent("mouseup", { detail: 1, button: 0, clientX: 50, clientY: 15 }));
      vi.runAllTimers();
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: "common.chat.citations.citeSelection" }));

    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({ text: "nginx is out of workers", prefix: "The cause: " }),
      expect.objectContaining({ source: text.parentElement?.parentElement }),
    );
    expect(onCite.mock.calls[0][0]).not.toHaveProperty("comment");
    expect(document.getSelection()?.isCollapsed ?? true).toBe(true);
  });
});

describe("a citation's comment in the composer", () => {
  function renderChip(overrides: Partial<React.ComponentProps<typeof CitationChip>["commentEditor"] & object> = {}) {
    const commentEditor = { open: true, onOpenChange: vi.fn(), onCancel: vi.fn(), onSave: vi.fn(), onSaveAndSend: vi.fn(() => true), ...overrides };
    render(<CitationChip citation={{ ...citation, comment: undefined }} onRemove={vi.fn()} commentEditor={commentEditor} />);
    return commentEditor;
  }

  it("saves on Enter and closes", () => {
    const editor = renderChip();
    const input = screen.getByPlaceholderText("common.chat.citations.commentPlaceholder");
    fireEvent.change(input, { target: { value: "  Raise worker_processes?  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editor.onSave).toHaveBeenCalledWith("Raise worker_processes?");
    expect(editor.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("saves and sends on Command+Enter, keeps Shift+Enter for a new line, and cancels on Escape", () => {
    const editor = renderChip();
    const input = screen.getByPlaceholderText("common.chat.citations.commentPlaceholder");
    fireEvent.change(input, { target: { value: "Which host?" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(editor.onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(editor.onSaveAndSend).toHaveBeenCalledWith("Which host?");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(editor.onCancel).toHaveBeenCalled();
  });

  it("stays open when Command+Enter cannot send the message", () => {
    const editor = renderChip({ onSaveAndSend: vi.fn(() => false) });
    const input = screen.getByPlaceholderText("common.chat.citations.commentPlaceholder");
    fireEvent.change(input, { target: { value: "Which host?" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(editor.onSaveAndSend).toHaveBeenCalledWith("Which host?");
    expect(editor.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("keeps an editor opened from the pencil when its answer leaves the list", async () => {
    document.body.innerHTML = "";
    const answer = document.createElement("div");
    answer.setAttribute("data-citation-source", citation.sourceId);
    answer.innerHTML = "<p>The cause: nginx is out of workers.</p>";
    document.body.append(answer);
    const editor = renderChip();
    answer.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(editor.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("common.chat.citations.commentPlaceholder")).toBeTruthy();
  });

  it("will not save a comment over the limit", () => {
    const editor = renderChip();
    const input = screen.getByPlaceholderText("common.chat.citations.commentPlaceholder");
    fireEvent.change(input, { target: { value: "x".repeat(2_001) } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(editor.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "common.chat.citations.shortenComment" })).toHaveProperty("disabled", true);
  });
});

describe("a sent message with a citation", () => {
  it("shows the quote as a card in its context, with the comment, and goes to the source", () => {
    const reveal = vi.fn();
    function Thread() {
      useCitationRevealer("incident-1", reveal);
      return <ChatBubble msg={{ kind: "user", text: joinCitations([citation], "Should we?") }} />;
    }
    render(<Thread />);

    expect(screen.getByText("nginx is out of workers").tagName).toBe("MARK");
    expect(screen.getByText("Raise worker_processes?")).toBeTruthy();
    expect(screen.getByText("Should we?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.chat.citations.goToQuote" }));

    expect(reveal).toHaveBeenCalledWith(citation, expect.any(Function));
  });
});

describe("going to a citation's source in a virtualized list", () => {
  const agentMessage = (iterationId: string): ChatMessage => ({
    kind: "agent",
    id: `message-${iterationId}`,
    iterations: [{ id: iterationId, startedAt: "2026-08-11T00:00:00.000Z", text: "", toolCallIds: [], status: "done" }],
    activeIterationId: null,
    toolCalls: [],
    finalText: null,
    status: "done",
  });
  const fakeList = (onScrollToIndex: () => void): CitationRevealList & { scrollToIndex: ReturnType<typeof vi.fn> } => {
    const node = document.createElement("div");
    document.body.append(node);
    return {
      getScrollableNode: () => node,
      scrollToIndex: vi.fn(() => {
        onScrollToIndex();
        return Promise.resolve();
      }),
      scrollToOffset: vi.fn(() => Promise.resolve()),
    };
  };

  it("scrolls an unmounted source's message into view, then marks the quote once its row mounts", async () => {
    document.body.innerHTML = "";
    const messages = [agentMessage("iteration-0"), { kind: "user", text: "Why?" } as ChatMessage, agentMessage("iteration-1")];
    const list = fakeList(() => {
      (list.getScrollableNode() as HTMLElement).innerHTML = `<div data-citation-source="iteration-1:text"><p>The cause: nginx is out of workers.</p></div>`;
    });
    const onSettled = vi.fn();

    revealCitationInList({ citation, messages, list, onSettled });

    expect(list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 2 }));
    // Without the CSS highlight API, the quote is selected instead.
    await waitFor(() => { expect(document.getSelection()?.toString()).toBe("nginx is out of workers"); });
    expect(onSettled).toHaveBeenCalledWith("highlighted");
    expect(document.activeElement).toBe(document.querySelector("[data-citation-source]"));
  });

  it("says the quote changed when its answer no longer has it", async () => {
    document.body.innerHTML = "";
    const list = fakeList(() => undefined);
    (list.getScrollableNode() as HTMLElement).innerHTML = `<div data-citation-source="iteration-1:text"><p>Rewritten.</p></div>`;
    const onSettled = vi.fn();
    revealCitationInList({ citation, messages: [agentMessage("iteration-1")], list, onSettled });
    await waitFor(() => { expect(onSettled).toHaveBeenCalledWith("changed"); });
  });

  it("stops a pending scroll to an unmounted source on Escape", () => {
    document.body.innerHTML = "";
    const list = fakeList(() => undefined);
    const onSettled = vi.fn();
    revealCitationInList({ citation, messages: [agentMessage("iteration-1")], list, onSettled });
    expect(list.scrollToIndex).toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(list.scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it("finds a quote in an answer shown under another id", async () => {
    document.body.innerHTML = "";
    const list = fakeList(() => undefined);
    (list.getScrollableNode() as HTMLElement).innerHTML = `<div data-citation-source="message-9:text"><p>The cause: nginx is out of workers.</p></div>`;
    const onSettled = vi.fn();
    revealCitationInList({ citation: { ...citation, sourceId: "live-step:text" }, messages: [], list, onSettled });
    await waitFor(() => { expect(onSettled).toHaveBeenCalledWith("highlighted"); });
    expect(document.getSelection()?.toString()).toBe("nginx is out of workers");
  });

  it("does not reveal a short quote in an unrelated answer while its own answer is unmounted", async () => {
    document.body.innerHTML = "";
    const list = fakeList(() => {
      (list.getScrollableNode() as HTMLElement).insertAdjacentHTML("beforeend", `<div data-citation-source="iteration-1:text"><p>The cause: nginx is out of workers.</p></div>`);
    });
    (list.getScrollableNode() as HTMLElement).innerHTML = `<div data-citation-source="iteration-2:text"><p>Later: nginx is out of workers again.</p></div>`;
    const onSettled = vi.fn();
    revealCitationInList({ citation, messages: [agentMessage("iteration-1"), agentMessage("iteration-2")], list, onSettled });
    expect(list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    await waitFor(() => { expect(onSettled).toHaveBeenCalledWith("highlighted"); });
    expect(document.activeElement?.getAttribute("data-citation-source")).toBe("iteration-1:text");
  });

  it("scrolls to a reloaded answer that is not mounted, found by its quote", async () => {
    document.body.innerHTML = "";
    const reloaded: ChatMessage = { ...agentMessage("message-7"), finalText: "The cause: nginx is out of workers." };
    const list = fakeList(() => {
      (list.getScrollableNode() as HTMLElement).innerHTML = `<div data-citation-source="message-7:text"><p>The cause: nginx is out of workers.</p></div>`;
    });
    const onSettled = vi.fn();
    revealCitationInList({ citation: { ...citation, sourceId: "live-step:text" }, messages: [reloaded, { kind: "user", text: "Why?" }], list, onSettled });
    expect(list.scrollToIndex).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    await waitFor(() => { expect(onSettled).toHaveBeenCalledWith("highlighted"); });
  });

  it("reports a reveal the engineer cancels", () => {
    document.body.innerHTML = "";
    const list = fakeList(() => undefined);
    const onSettled = vi.fn();
    revealCitationInList({ citation, messages: [agentMessage("iteration-1")], list, onSettled });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onSettled).toHaveBeenCalledWith("cancelled");
  });

  it("reports a source that is not in the list", () => {
    const list = fakeList(() => undefined);
    const onSettled = vi.fn();
    revealCitationInList({ citation: { ...citation, sourceId: "gone:text" }, messages: [agentMessage("iteration-1")], list, onSettled });
    expect(list.scrollToIndex).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith("missing");
  });
});

describe("an answer without iterations", () => {
  it("can be cited once it is saved", () => {
    render(<TurnTimeline msg={{ kind: "agent", id: "message-9", iterations: [], activeIterationId: null, toolCalls: [], finalText: "Restart nginx.", status: "done" }} nowMs={0} />);
    expect(document.querySelector('[data-citation-source="message-9:final"]')).not.toBeNull();
  });
});

describe("an incident's quotes", () => {
  afterEach(() => { useIncidentDraftStore.setState({ drafts: {}, citations: {}, openComments: {} }); });

  it("belong to their incident, and the composer removes one or changes its comment", () => {
    addIncidentCitation("incident-1", citation);
    addIncidentCitation("incident-1", { ...citation, text: "nginx", comment: undefined, start: 10, end: 15 });
    addIncidentCitation("incident-2", citation);
    const { result } = renderHook(() => useIncidentCitations("incident-1"));
    expect(result.current.citations.map((quote) => quote.text)).toEqual(["nginx is out of workers", "nginx"]);

    act(() => { result.current.onCitationCommentChange(1, "Which host?"); });
    act(() => { result.current.onRemoveCitation(0); });

    expect(result.current.citations).toEqual([expect.objectContaining({ text: "nginx", comment: "Which host?" })]);
    expect(separateCitations(readComposedDraft("incident-1")).citations).toHaveLength(1);
    expect(useIncidentDraftStore.getState().citations["incident-2"]).toEqual([citation]);
  });

  it("opens a new quote's comment under it, and Cancel takes the quote back", () => {
    const anchor = { source: document.body, range: document.createRange(), viewport: document.body };
    addIncidentCitation("incident-1", citation);
    addIncidentCitation("incident-1", { ...citation, text: "nginx", start: 10, end: 15 }, anchor);
    const { result } = renderHook(() => useIncidentCitations("incident-1"));
    expect(result.current.citationCommentEditor(1)).toMatchObject({ open: true, sourceAnchor: anchor });
    expect(result.current.citationCommentEditor(0).open).toBe(false);

    act(() => { result.current.citationCommentEditor(1).onCancel(); });

    expect(result.current.citations.map((quote) => quote.text)).toEqual(["nginx is out of workers"]);
    expect(result.current.citationCommentEditor(0).open).toBe(false);
  });

  it("opens the existing chip when the same text is cited again", () => {
    addIncidentCitation("incident-1", citation);
    addIncidentCitation("incident-1", citation, { source: document.body, range: document.createRange(), viewport: document.body });
    const { result } = renderHook(() => useIncidentCitations("incident-1"));
    expect(result.current.citations).toHaveLength(1);
    expect(result.current.citationCommentEditor(0).open).toBe(true);
    act(() => { result.current.citationCommentEditor(0).onCancel(); });
    expect(result.current.citations).toHaveLength(1);
  });

  it("keeps an earlier quote when its reopened comment is cancelled", () => {
    addIncidentCitation("incident-1", citation);
    const { result } = renderHook(() => useIncidentCitations("incident-1"));
    act(() => { result.current.citationCommentEditor(0).onOpenChange(false); });
    act(() => { result.current.citationCommentEditor(0).onOpenChange(true); });
    act(() => { result.current.citationCommentEditor(0).onCancel(); });
    expect(result.current.citations).toEqual([citation]);
    expect(result.current.citationCommentEditor(0).open).toBe(false);
  });
});
