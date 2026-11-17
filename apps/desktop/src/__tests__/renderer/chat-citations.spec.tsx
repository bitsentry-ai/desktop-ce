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
import { captureSelectionCitation, resolveCitationRange, revealCitationInMessages } from "@bitsentry-ce/components/chat/citationDom";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import {
  addIncidentCitation,
  readComposedDraft,
  useIncidentCitations,
  useIncidentDraftStore,
} from "@bitsentry-ce/components/investigation/incidents/incidentDraftStore";
import { CitationSelectionToolbar } from "@bitsentry-ce/components/chat/CitationControls";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeAll(() => {
  // jsdom has no layout; the toolbar only needs a rectangle to sit next to.
  const rect = { x: 0, y: 0, top: 10, left: 10, bottom: 20, right: 100, width: 90, height: 10, toJSON: () => ({}) };
  Element.prototype.scrollIntoView = () => {};
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
});

afterEach(() => {
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

  it("ignores a selection that spans two answers", () => {
    document.body.innerHTML = `<div id="viewport"><div data-citation-source="a"><p>One.</p></div><div data-citation-source="b"><p>Two.</p></div></div>`;
    const [first, second] = [...document.querySelectorAll("p")].map((paragraph) => paragraph.firstChild as Text);
    selectText(first, 0, second, 3);

    expect(captureSelectionCitation(document.getElementById("viewport")!, "incident-1")).toBeNull();
  });

  it("cites the selection with a comment", () => {
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
    vi.useFakeTimers();
    render(<Harness />);
    const text = screen.getByText(/The cause/).firstChild as Text;

    selectText(text, 11, text, 34);
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { detail: 1 }));
      vi.runAllTimers();
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("button", { name: /common.chat.citations.cite/ }));
    fireEvent.change(screen.getByPlaceholderText("common.chat.citations.commentPlaceholder"), { target: { value: "Raise worker_processes?" } });
    fireEvent.click(screen.getByRole("button", { name: "common.actions.save" }));

    expect(onCite).toHaveBeenCalledWith(expect.objectContaining({
      text: "nginx is out of workers",
      comment: "Raise worker_processes?",
      prefix: "The cause: ",
    }));
  });
});

describe("a sent message with a citation", () => {
  it("shows the citation as a chip that opens the quote", () => {
    render(<ChatBubble msg={{ kind: "user", text: joinCitations([citation], "Should we?") }} />);

    fireEvent.click(screen.getByRole("button", { name: "common.chat.citations.viewQuote" }));

    expect(screen.getByText("nginx is out of workers")).toBeTruthy();
    expect(screen.getByText("Should we?")).toBeTruthy();
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

  it("scrolls an unmounted source's message into view, then selects the quote once its row mounts", async () => {
    document.body.innerHTML = "";
    const messages = [agentMessage("iteration-0"), { kind: "user", text: "Why?" } as ChatMessage, agentMessage("iteration-1")];
    const scrollToIndex = vi.fn(() => {
      document.body.innerHTML = `<div data-citation-source="iteration-1:text"><p>The cause: nginx is out of workers.</p></div>`;
    });

    revealCitationInMessages(citation, messages, scrollToIndex);

    expect(scrollToIndex).toHaveBeenCalledWith(2);
    await waitFor(() => { expect(document.getSelection()?.toString()).toBe("nginx is out of workers"); });
  });

  it("does nothing for a source that is not in the list", () => {
    const scrollToIndex = vi.fn();
    revealCitationInMessages({ ...citation, sourceId: "gone:text" }, [agentMessage("iteration-1")], scrollToIndex);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

describe("an incident's quotes", () => {
  afterEach(() => { useIncidentDraftStore.setState({ drafts: {}, citations: {} }); });

  it("belong to their incident, and the composer removes one or changes its comment", () => {
    addIncidentCitation("incident-1", citation);
    addIncidentCitation("incident-1", { ...citation, text: "nginx", comment: undefined });
    addIncidentCitation("incident-2", citation);
    const { result } = renderHook(() => useIncidentCitations("incident-1"));
    expect(result.current.citations.map((quote) => quote.text)).toEqual(["nginx is out of workers", "nginx"]);

    act(() => { result.current.onCitationCommentChange(1, "Which host?"); });
    act(() => { result.current.onRemoveCitation(0); });

    expect(result.current.citations).toEqual([expect.objectContaining({ text: "nginx", comment: "Which host?" })]);
    expect(separateCitations(readComposedDraft("incident-1")).citations).toHaveLength(1);
    expect(useIncidentDraftStore.getState().citations["incident-2"]).toEqual([citation]);
  });
});
