// @vitest-environment jsdom

import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRunbookActionEditorFlow } from "@bitsentry-ce/components/desktop/runbook/useRunbookActionEditorFlow";
import { saveBlockedReasonKey } from "@bitsentry-ce/components/desktop/runbook/actionDraftGuard";
import type {
  RunbookActionRecord,
  RunbookRecord,
} from "@bitsentry-ce/components/services";

Element.prototype.scrollIntoView = () => undefined;

const saved: RunbookRecord = {
  id: "runbook-1",
  title: "Test runbook",
  description: "",
  revisionNumber: 1,
  actions: [{ id: "a", type: "shell", title: "Check disk", command: "df -h" }],
  createdAt: "2026-11-26T00:00:00.000Z",
  updatedAt: "2026-11-26T00:00:00.000Z",
};

function Harness() {
  const [editing, setEditing] = useState<RunbookRecord | null>(saved);
  const flow = useRunbookActionEditorFlow({
    activeRunbook: saved,
    activeEditingRunbook: editing,
    setEditingRunbook: setEditing,
    ipcInvoke: async <T,>() => saved as T,
    captureDesktopAnalyticsEvent: () => undefined,
    summarizeRunbookForTelemetry: () => ({}),
    summarizeRunbookActionForTelemetry: () => ({}),
    replaceRunbook: () => undefined,
    validErrorSourceIds: new Set(),
    validPluginActionIdsByPluginId: new Map(),
  });
  const expanded: RunbookActionRecord | undefined = editing?.actions.find(
    (action) => action.id === flow.expandedId,
  );
  return (
    <>
      <div data-testid="outside">outside</div>
      <button type="button" onClick={() => flow.handleAddActionAt(1)}>
        Add
      </button>
      <button type="button" onClick={() => flow.handleActionCardClick("a")}>
        Open saved
      </button>
      <p data-testid="state">
        {`${String(editing?.actions.length)} steps, open: ${flow.expandedId === null ? "none" : "one"}, dirty: ${String(flow.expandedDraftDirty)}, nudge: ${String(flow.unsavedNudge)}`}
      </p>
      {expanded !== undefined && (
        <div ref={flow.expandedCardRef}>
          <input
            aria-label="Title"
            value={expanded.title}
            onChange={(event) =>
              flow.handleUpdateActionDraft({
                ...expanded,
                title: event.target.value,
              })
            }
          />
          <button type="button" onClick={flow.collapse}>
            Discard
          </button>
        </div>
      )}
    </>
  );
}

async function clickOutside() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  fireEvent.mouseDown(screen.getByTestId("outside"));
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

describe("open runbook step drafts on desktop", () => {
  it("keeps a new step with typed details when the user clicks away", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Restart nginx" },
    });
    await clickOutside();
    expect(screen.getByTestId("state").textContent).toBe(
      "2 steps, open: one, dirty: true, nudge: 1",
    );
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Restart nginx",
    );
  });

  it("closes an untouched new step on a click away", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Add"));
    await clickOutside();
    expect(screen.getByTestId("state").textContent).toBe(
      "1 steps, open: none, dirty: false, nudge: 0",
    );
  });

  it("keeps an edited saved step open on a click away, and discards only on request", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open saved"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Check disks" },
    });
    await clickOutside();
    expect(screen.getByTestId("state").textContent).toContain("open: one");
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.getByTestId("state").textContent).toBe(
      "1 steps, open: none, dirty: false, nudge: 0",
    );
  });

  it("does not open a new step over one with unsaved edits", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Open saved"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Check disks" },
    });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByTestId("state").textContent).toBe(
      "1 steps, open: one, dirty: true, nudge: 1",
    );
  });

  it("brings a typed new step back when the runbook is opened again", async () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByText("Add"));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Restart nginx" },
    });
    first.unmount();
    render(<Harness />);
    expect(screen.getByTestId("state").textContent).toBe(
      "2 steps, open: one, dirty: true, nudge: 0",
    );
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Restart nginx",
    );
    fireEvent.click(screen.getByText("Discard"));
    expect(screen.getByTestId("state").textContent).toBe(
      "1 steps, open: none, dirty: false, nudge: 0",
    );
  });

  it("says why a step cannot be saved yet", () => {
    expect(saveBlockedReasonKey({ title: "  " }, false)).toBe("runbooks.runbook.saveNeedsTitle");
    expect(saveBlockedReasonKey({ title: "Check disk" }, false)).toBe("runbooks.runbook.saveNeedsFixes");
    expect(saveBlockedReasonKey({ title: "" }, true)).toBeNull();
  });
});
