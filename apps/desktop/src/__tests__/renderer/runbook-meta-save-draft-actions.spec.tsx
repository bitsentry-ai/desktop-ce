// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRunbookCatalogFlow } from "@bitsentry-ce/components/desktop/runbook/useRunbookCatalogFlow";
import { useRunbookPersistenceFlow } from "@bitsentry-ce/components/desktop/runbook/useRunbookPersistenceFlow";
import type {
  RunbookActionRecord,
  RunbookRecord,
} from "@bitsentry-ce/components/services";

const persisted: RunbookRecord = {
  id: "a",
  title: "New Runbook",
  description: "",
  revisionNumber: 1,
  createdAt: "2026-11-17T00:00:00.000Z",
  updatedAt: "2026-11-17T00:00:00.000Z",
  actions: [],
};
const draftAction: RunbookActionRecord = {
  id: "draft-1",
  type: "shell",
  title: "",
  command: "",
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("runbook metadata save", () => {
  it("keeps an unsaved draft action added while the title save is in flight", async () => {
    let finishMetaSave: (runbook: RunbookRecord) => void = () => {};
    const ipcInvoke = async <T,>(channel: string): Promise<T> => {
      if (channel === "runbooks:updateMeta") {
        return new Promise<RunbookRecord>((resolve) => {
          finishMetaSave = resolve;
        }) as Promise<T>;
      }
      return [persisted] as T;
    };
    const { result } = renderHook(() => {
      const catalog = useRunbookCatalogFlow({
        activeId: "a",
        ipcInvoke,
        captureDesktopAnalyticsEvent: () => {},
        summarizeRunbookForTelemetry: () => ({}),
        navigateToRunbook: () => {},
        navigateToRunbooks: () => {},
      });
      const persistence = useRunbookPersistenceFlow({
        activeRunbook: catalog.activeRunbook,
        editingRunbook: catalog.editingRunbook,
        runbooks: catalog.runbooks,
        setEditingRunbook: catalog.setEditingRunbook,
        replaceRunbook: catalog.replaceRunbook,
        ipcInvoke,
        showSaveDialog: async () => ({ filePath: null, canceled: true }),
        t: (key: string) => key,
        toast: () => {},
      });
      return { catalog, persistence };
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Blurring the title starts the save; the click that blurred it adds a draft action.
    let save: Promise<void> = Promise.resolve();
    act(() => {
      save = result.current.persistence.commitMeta({ title: "Renamed" });
    });
    act(() => {
      result.current.catalog.setEditingRunbook((prev) =>
        prev === null ? prev : { ...prev, actions: [draftAction] },
      );
    });
    await act(async () => {
      finishMetaSave({ ...persisted, title: "Renamed", revisionNumber: 2 });
      await save;
    });

    expect(result.current.catalog.editingRunbook?.title).toBe("Renamed");
    expect(
      result.current.catalog.editingRunbook?.actions.map((action) => action.id),
    ).toEqual(["draft-1"]);
  });
});
