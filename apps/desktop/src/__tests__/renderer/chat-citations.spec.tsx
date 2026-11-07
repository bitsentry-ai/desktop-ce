// @vitest-environment jsdom

import React, { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  expandCitationsForModel,
  findCitationRange,
  joinCitations,
  separateCitations,
  type AssistantCitation,
} from "@bitsentry-ce/components/chat/citations";
import { captureSelectionCitation, resolveCitationRange } from "@bitsentry-ce/components/chat/citationDom";
import { CitationSelectionToolbar } from "@bitsentry-ce/components/chat/CitationControls";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

beforeAll(() => {
  // jsdom has no layout; the toolbar only needs a rectangle to sit next to.
  const rect = { x: 0, y: 0, top: 10, left: 10, bottom: 20, right: 100, width: 90, height: 10, toJSON: () => ({}) };
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
          <CitationSelectionToolbar viewportRef={viewportRef} threadId="incident-1" onCite={onCite} />
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
