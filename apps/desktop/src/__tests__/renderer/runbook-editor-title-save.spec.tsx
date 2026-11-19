// @vitest-environment jsdom
import React, { type ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider, loadNamespaces } from "@bitsentry-ce/i18n";
import DesktopRunbookPage from "@bitsentry-ce/components/desktop/DesktopRunbookPage";
import type { SortableItemProps } from "@bitsentry-ce/components/desktop/runbook/RunbookActionList";
import { BitsentryServicesProvider } from "@bitsentry-ce/components/services/context";
import { createDesktopLocalBitsentryServices } from "@bitsentry-ce/components/services/desktop-local-services";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";
import type { RunbookRecord } from "@bitsentry-ce/components/services";

// jsdom has no layout APIs; drag and drop (on import) and the editor's scrolling use them.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  // The preload bridge: nothing pushes events, and other calls have no data.
  const unsubscribe = () => {};
  const subscribe = () => unsubscribe;
  const noData = async () => undefined;
  const quietNamespace = new Proxy(
    {},
    { get: (_target, name) => (String(name).startsWith("on") ? subscribe : noData) },
  );
  const namespaces: Record<string, unknown> = {
    updater: { getState: async () => ({ status: "idle" }), onState: subscribe },
  };
  (window as { bitsentry?: unknown }).bitsentry = new Proxy(
    {},
    { get: (_target, name) => namespaces[String(name)] ?? quietNamespace },
  );
});

type PageProps = ComponentProps<typeof DesktopRunbookPage>;

function SortableItem({ children, ...options }: SortableItemProps) {
  const { ref, isDragging, isDragSource, isDropTarget } = useSortable(options);
  return children({ ref, isDragging, isDragSource, isDropTarget });
}

const dragDropRuntime = {
  DragDropProvider,
  isSortable: isSortable as PageProps["dragDropRuntime"]["isSortable"],
  SortableItem,
} satisfies PageProps["dragDropRuntime"];


// The app loads the runbooks texts before it opens the screen; so does this test.
beforeAll(() => loadNamespaces(["runbooks"]));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/**
 * Stands in for the desktop main process: it holds one runbook, and keeps each
 * metadata save waiting until the test lets it finish.
 */
function createMainProcess(initial: RunbookRecord) {
  let stored = structuredClone(initial);
  const pending: Array<() => void> = [];
  const ipcInvoke = async <T,>(channel: string, payload?: unknown): Promise<T> => {
    switch (channel) {
      case "runbooks:list":
        return [structuredClone(stored)] as T;
      case "runbooks:get":
        return structuredClone(stored) as T;
      case "runbooks:updateMeta":
        return new Promise<T>((resolve) => {
          pending.push(() => {
            // Like the real store: the details change, the revision does not.
            const { title } = payload as { title?: string };
            stored = {
              ...stored,
              title: title ?? stored.title,
              updatedAt: new Date(Date.parse(stored.updatedAt) + 5000).toISOString(),
            };
            resolve(structuredClone(stored) as T);
          });
        });
      case "globals:list":
        return [] as T;
      case "settings:getGeneral":
        return {} as T;
      default:
        // Plugins, error sources and the rest: nothing installed.
        return { data: [] } as T;
    }
  };
  return {
    ipcInvoke,
    /** Lets every waiting save finish, then lets the page handle the replies. */
    async finishSaves() {
      await act(async () => {
        for (const finish of pending.splice(0)) finish();
        // Every follow-up is a promise; one macrotask runs after all of them.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    pendingSaves: () => pending.length,
  };
}

function renderEditor(runbook: RunbookRecord) {
  const main = createMainProcess(runbook);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BitsentryServicesProvider
        services={createDesktopLocalBitsentryServices({ ipcInvoke: main.ipcInvoke })}
      >
        <I18nProvider locale="en-US" detectLocale={false}>
          <TooltipProvider>
            <MemoryRouter initialEntries={[`/runbooks?id=${runbook.id}`]}>
              <DesktopRunbookPage
                ipcInvoke={main.ipcInvoke}
                captureDesktopAnalyticsEvent={() => {}}
                dragDropRuntime={dragDropRuntime}
              />
            </MemoryRouter>
          </TooltipProvider>
        </I18nProvider>
      </BitsentryServicesProvider>
    </QueryClientProvider>,
  );
  return main;
}

describe("runbook editor", () => {
  it("keeps a step added right after renaming the runbook", async () => {
    const user = userEvent.setup();
    const main = renderEditor({
      id: "rb-1",
      title: "New Runbook",
      description: "",
      revisionNumber: 1,
      createdAt: "2026-11-17T00:00:00.000Z",
      updatedAt: "2026-11-17T00:00:00.000Z",
      actions: [],
    });

    const title = await screen.findByPlaceholderText("Runbook title");
    // Select the old title and type over it.
    await user.tripleClick(title);
    await user.keyboard("Renamed");
    // The click moves focus off the title, which starts saving it.
    await user.click(screen.getByRole("button", { name: "Add first action" }));
    expect(main.pendingSaves()).toBe(1);
    expect(screen.getByPlaceholderText("./scripts/fetch-logs.sh --since 1h")).toBeTruthy();

    await main.finishSaves();

    expect(screen.getByPlaceholderText("./scripts/fetch-logs.sh --since 1h")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add first action" })).toBeNull();
    expect(screen.getByPlaceholderText<HTMLInputElement>("Runbook title").value).toBe("Renamed");
  });
});
