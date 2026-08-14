// @vitest-environment jsdom

import React, { useCallback, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunbookActionList } from "@bitsentry-ce/components/desktop/runbook/RunbookActionList";
import { useRunbookActionEditorFlow } from "@bitsentry-ce/components/desktop/runbook/useRunbookActionEditorFlow";
import type {
  RunbookActionRecord,
  RunbookRecord,
} from "@bitsentry-ce/components/services";

type SortableOptions = {
  id: string;
  index: number;
  disabled: boolean;
  group: string;
  type: string;
  accept: string;
};

type SortableNodeRegistry = Map<string, HTMLElement>;

const translations = {
  "runbooks.runbook.addAction": "Add action",
  "runbooks.runbook.addActionHere": "Add action here",
};

function makeAction(id: string): RunbookActionRecord {
  return { id, type: "shell", title: `Action ${id}`, command: "pwd" };
}

function makeRunbook(actions: RunbookActionRecord[]): RunbookRecord {
  return {
    id: "runbook-1",
    title: "Test runbook",
    description: "",
    revisionNumber: 1,
    actions,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
  };
}

function makeSortableRuntime(registry: SortableNodeRegistry) {
  return ({ id }: SortableOptions) => ({
    ref: (node: HTMLElement | null) => {
      if (node === null) {
        registry.delete(id);
      } else {
        registry.set(id, node);
      }
    },
    isDragging: false,
    isDragSource: false,
    isDropTarget: false,
  });
}

function renderList(
  actions: RunbookActionRecord[],
  registry: SortableNodeRegistry = new Map(),
) {
  return render(
    <RunbookActionList
      actions={actions}
      useSortableRuntime={makeSortableRuntime(registry)}
      isExpanded={() => false}
      renderExpandedCard={() => null}
      renderCollapsedCard={(action) => (
        <div data-action-id={action.id} data-testid={`action-${action.id}`}>
          {action.title}
        </div>
      )}
      onAddActionAt={() => undefined}
      t={(key) => translations[key as keyof typeof translations] ?? key}
    />,
  );
}

function actionOrder() {
  const list = document.querySelector<HTMLElement>(
    '[data-tour="runbooks-actions-list"]',
  );
  if (list === null) {
    throw new Error("Runbook action list was not rendered");
  }

  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-action-id]"),
  ).map((node) => node.dataset.actionId);
}

function connectorCountFor(actionId: string) {
  const action = screen.getByTestId(`action-${actionId}`);
  return Array.from(action.parentElement?.children ?? []).filter(
    (child) => child.getAttribute("aria-hidden") === "true",
  ).length;
}

function moveActionAfter(
  registry: SortableNodeRegistry,
  sourceId: string,
  targetId: string,
) {
  const source = registry.get(sourceId);
  const target = registry.get(targetId);
  if (source === undefined || target === undefined || target.parentElement === null) {
    throw new Error("Sortable test nodes were not registered");
  }

  target.parentElement.insertBefore(source, target.nextSibling);
}

function DesktopDragRevalidationHarness() {
  const [runbook, setRunbook] = useState<RunbookRecord | null>(() =>
    makeRunbook([makeAction("a"), makeAction("b"), makeAction("c")]),
  );
  const currentRunbook =
    runbook ?? makeRunbook([makeAction("a"), makeAction("b"), makeAction("c")]);
  const registryRef = useRef<SortableNodeRegistry>(new Map());
  const sortableRuntime = useCallback(
    (options: SortableOptions) =>
      makeSortableRuntime(registryRef.current)(options),
    [],
  );
  const flow = useRunbookActionEditorFlow({
    activeRunbook: currentRunbook,
    activeEditingRunbook: currentRunbook,
    setEditingRunbook: setRunbook,
    ipcInvoke: async <T,>() => currentRunbook as T,
    captureDesktopAnalyticsEvent: () => undefined,
    summarizeRunbookForTelemetry: () => ({}),
    summarizeRunbookActionForTelemetry: () => ({}),
    replaceRunbook: () => undefined,
    validErrorSourceIds: new Set(),
    validPluginActionIdsByPluginId: new Map(),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          moveActionAfter(registryRef.current, "a", "c");
          flow.handleActionDragEnd(
            { canceled: true, operation: { source: null } },
            (value): value is { initialIndex: number; index: number } =>
              typeof value === "object" && value !== null,
          );
        }}
      >
        Revalidate drag
      </button>
      <RunbookActionList
        actions={currentRunbook.actions}
        useSortableRuntime={sortableRuntime}
        isExpanded={() => false}
        renderExpandedCard={() => null}
        renderCollapsedCard={(action) => (
          <div data-action-id={action.id} data-testid={`action-${action.id}`}>
            {action.title}
          </div>
        )}
        onAddActionAt={() => undefined}
        t={(key) => translations[key as keyof typeof translations] ?? key}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("RunbookActionList render outcomes", () => {
  it("restores logical order after a sortable root is moved without an action reorder", () => {
    const registry = new Map<string, HTMLElement>();
    const actions = [makeAction("a"), makeAction("b"), makeAction("c")];
    const { rerender } = renderList(actions, registry);

    moveActionAfter(registry, "a", "c");
    rerender(
      <RunbookActionList
        actions={[...actions]}
        useSortableRuntime={makeSortableRuntime(registry)}
        isExpanded={() => false}
        renderExpandedCard={() => null}
        renderCollapsedCard={(action) => (
          <div data-action-id={action.id} data-testid={`action-${action.id}`}>
            {action.title}
          </div>
        )}
        onAddActionAt={() => undefined}
        t={(key) => translations[key as keyof typeof translations] ?? key}
      />,
    );

    expect(actionOrder()).toEqual(["a", "b", "c"]);
    expect(connectorCountFor("a")).toBe(1);
    expect(connectorCountFor("b")).toBe(1);
    expect(connectorCountFor("c")).toBe(0);
  });

  it("keeps the expanded add-action control inside its sortable element", () => {
    const registry = new Map<string, HTMLElement>();

    render(
      <RunbookActionList
        actions={[makeAction("a"), makeAction("b")]}
        useSortableRuntime={makeSortableRuntime(registry)}
        isExpanded={(action) => action.id === "a"}
        renderExpandedCard={(action) => (
          <div data-testid={`expanded-${action.id}`}>{action.title}</div>
        )}
        renderCollapsedCard={(action) => (
          <div data-action-id={action.id} data-testid={`action-${action.id}`}>
            {action.title}
          </div>
        )}
        onAddActionAt={() => undefined}
        t={(key) => translations[key as keyof typeof translations] ?? key}
      />,
    );

    const addActionButton = screen.getByRole("button", { name: "Add action here" });
    expect(addActionButton.parentElement?.parentElement).toBe(registry.get("a"));
  });

  it("restores committed order after a drag ends without a commit", () => {
    render(<DesktopDragRevalidationHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Revalidate drag" }));

    expect(actionOrder()).toEqual(["a", "b", "c"]);
    expect(connectorCountFor("c")).toBe(0);
  });
});
