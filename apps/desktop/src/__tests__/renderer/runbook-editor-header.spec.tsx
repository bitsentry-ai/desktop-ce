// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunbookEditorHeader } from "@bitsentry-ce/components/desktop/runbook/RunbookEditorHeader";
import type { RunbookRecord } from "@bitsentry-ce/components/services";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";

const translations: Record<string, string> = {
  "runbooks.runbook.run": "Run",
  "runbooks.runbook.runRunbook": "Run runbook",
  "runbooks.runbook.exportRunbook": "Export runbook",
  "runbooks.runbook.newRunbook": "New runbook",
  "runbooks.runbook.deleteRunbook": "Delete runbook",
  "runbooks.runbook.moreRunbookActions": "More runbook actions",
  "runbooks.runbook.viewRunbookResultHistory": "View result history",
  "runbooks.runbook.executionSettings": "Execution settings",
  "runbooks.runbook.runbookTitle": "Runbook title",
  "runbooks.runbook.addADescription": "Add a description",
  "runbooks.runbook.showFullDescription": "Show more",
  "runbooks.runbook.showShortDescription": "Show less",
  "common.actions.new": "New",
};

function t(key: string, options?: Record<string, unknown>) {
  if (key === "runbooks.runbooks.actionCount") {
    return `${String(options?.count)} actions`;
  }
  return translations[key] ?? key;
}

function makeRunbook(actionCount: number): RunbookRecord {
  return {
    id: "runbook-1",
    title: "Host health snapshot",
    description: "Load and memory",
    revisionNumber: 1,
    actions: Array.from({ length: actionCount }, (_, index) => ({
      id: `action-${String(index)}`,
      type: "shell" as const,
      title: `Action ${String(index)}`,
      command: "uptime",
    })),
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function renderHeader(
  overrides: Partial<React.ComponentProps<typeof RunbookEditorHeader>> = {},
) {
  const props: React.ComponentProps<typeof RunbookEditorHeader> = {
    runbook: makeRunbook(2),
    metaIssues: { titleIssue: null, descriptionIssue: null },
    currentTimeoutMinutes: 30,
    currentTimeoutLabel: "30m",
    idleTimeoutPresets: [{ value: 30, label: "30m" }],
    onTitleChange: vi.fn(),
    onTitleBlur: vi.fn(),
    onDescriptionChange: vi.fn(),
    onDescriptionBlur: vi.fn(),
    onIdleTimeoutChange: vi.fn(),
    onExport: vi.fn(),
    onOpenResults: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onCreateRunbook: vi.fn(),
    t,
    ...overrides,
  };
  render(
    <TooltipProvider>
      <RunbookEditorHeader {...props} />
    </TooltipProvider>,
  );
  return props;
}

function openOverflowMenu() {
  const trigger = screen.getByRole("button", { name: "More runbook actions" });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

/** Pretends the header measures `width` pixels; the toolbar must not depend on it. */
function setHeaderWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width,
    height: 120,
    top: 0,
    left: 0,
    right: width,
    bottom: 120,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

const exportContextAction = (onSelect: () => void) => ({
  id: "export-context",
  label: "Export runbook context",
  icon: null,
  onSelect,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("RunbookEditorHeader", () => {
  it("shows Run as a labelled primary button that runs the runbook", () => {
    const props = renderHeader();

    const run = screen.getByRole("button", { name: "Run runbook" });
    expect(run.textContent).toContain("Run");
    expect(run.getAttribute("data-tour")).toBe("runbooks-run-btn");
    expect(run.className).toContain("bg-primary");

    fireEvent.click(run);
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  it("disables Run while the runbook has no actions", () => {
    renderHeader({ runbook: makeRunbook(0) });

    expect(
      screen
        .getByRole("button", { name: "Run runbook" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it.each([1100, 390])(
    "keeps History and New visible and groups export and delete in the ⋯ menu at %ipx",
    (width) => {
      setHeaderWidth(width);
      const onExportContext = vi.fn();
      const props = renderHeader({
        overflowActions: [exportContextAction(onExportContext)],
        extraActions: <button type="button">Step credentials</button>,
      });

      expect(screen.getByRole("button", { name: "Run runbook" })).toBeTruthy();
      // Execution settings stay inline as one group.
      const settings = screen.getByRole("group", {
        name: "Execution settings",
      });
      expect(settings.textContent).toContain("Step credentials");

      const history = screen.getByRole("button", {
        name: "View result history",
      });
      expect(history.getAttribute("data-tour")).toBe("runbooks-history-btn");
      fireEvent.click(history);
      expect(props.onOpenResults).toHaveBeenCalledTimes(1);

      const newRunbook = screen.getByRole("button", { name: "New runbook" });
      expect(newRunbook.getAttribute("data-tour")).toBe("runbooks-new-btn");
      expect(newRunbook.className).toContain("border");
      expect(newRunbook.className).not.toContain("bg-primary");
      fireEvent.click(newRunbook);
      expect(props.onCreateRunbook).toHaveBeenCalledTimes(1);

      for (const name of [
        "Export runbook",
        "Export runbook context",
        "Delete runbook",
      ]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }

      openOverflowMenu();
      const menuItems = screen.getAllByRole("menuitem");
      // History and New runbook are menu items only below 640px; from sm up they are hidden there.
      const narrowOnly = menuItems.filter((item) => item.className.includes("sm:hidden"));
      expect(narrowOnly.map((item) => item.textContent)).toEqual([
        "View result history",
        "New runbook",
      ]);
      const items = menuItems
        .filter((item) => !narrowOnly.includes(item))
        .map((item) => item.textContent);
      expect(items).toEqual([
        "Export runbook",
        "Export runbook context",
        "Delete runbook",
      ]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Export runbook" }));
      expect(props.onExport).toHaveBeenCalledTimes(1);

      openOverflowMenu();
      fireEvent.click(
        screen.getByRole("menuitem", { name: "Export runbook context" }),
      );
      expect(onExportContext).toHaveBeenCalledTimes(1);

      openOverflowMenu();
      const deleteItem = screen.getByRole("menuitem", {
        name: "Delete runbook",
      });
      expect(deleteItem.className).toContain("text-destructive");
      expect(deleteItem.previousElementSibling?.getAttribute("role")).toBe(
        "separator",
      );
      fireEvent.click(deleteItem);
      expect(props.onDelete).toHaveBeenCalledTimes(1);
    },
  );

  it("shows the description as a two-line preview until it is focused", () => {
    const props = renderHeader();

    const preview = screen.getByText("Load and memory", { selector: "p" });
    expect(preview.className).toContain("line-clamp-2");
    const description = screen.getByRole("textbox", {
      name: "Add a description",
    });
    expect(description.className).toContain("sr-only");

    fireEvent.focus(description);
    expect(screen.queryByText("Load and memory", { selector: "p" })).toBeNull();
    expect(description.className).not.toContain("sr-only");

    fireEvent.blur(description);
    expect(props.onDescriptionBlur).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Load and memory", { selector: "p" }).className,
    ).toContain("line-clamp-2");
  });

  it("offers Show more only when the clamp hides part of the description", () => {
    renderHeader();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    cleanup();

    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockReturnValue(54);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(36);
    try {
      renderHeader();
      const more = screen.getByRole("button", { name: "Show more" });
      expect(more.getAttribute("aria-expanded")).toBe("false");

      fireEvent.click(more);
      const less = screen.getByRole("button", { name: "Show less" });
      expect(less.getAttribute("aria-expanded")).toBe("true");
      expect(
        screen.getByText("Load and memory", { selector: "p" }).className,
      ).not.toContain("line-clamp-2");

      fireEvent.click(less);
      expect(
        screen.getByText("Load and memory", { selector: "p" }).className,
      ).toContain("line-clamp-2");
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
  });

  it("keeps the runbook title on one logical line", () => {
    const props = renderHeader();

    const title = screen.getByRole("textbox", { name: "Runbook title" });
    fireEvent.change(title, { target: { value: "Host\nhealth" } });
    expect(props.onTitleChange).toHaveBeenCalledWith("Host health");
  });
});
