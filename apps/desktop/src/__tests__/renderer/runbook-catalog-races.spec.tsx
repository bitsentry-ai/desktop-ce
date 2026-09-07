// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRunbookCatalogFlow } from "@bitsentry-ce/components/desktop/runbook/useRunbookCatalogFlow";
import type { RunbookRecord } from "@bitsentry-ce/components/services";

const first: RunbookRecord = {
  id: "a",
  title: "First",
  description: "",
  revisionNumber: 1,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  actions: [],
};
const second: RunbookRecord = { ...first, id: "b", title: "Second" };
const options = {
  ipcInvoke: async <T,>() => [first, second] as T,
  captureDesktopAnalyticsEvent: () => {},
  summarizeRunbookForTelemetry: () => ({}),
  navigateToRunbook: () => {},
  navigateToRunbooks: () => {},
};
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("runbook catalog save races", () => {
  it("does not replace the newly selected draft with a previous runbook save", async () => {
    const { result, rerender } = renderHook(
      ({ activeId }) => useRunbookCatalogFlow({ ...options, activeId }),
      { initialProps: { activeId: "a" } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    const finishOldSave = result.current.replaceRunbook;
    rerender({ activeId: "b" });
    act(() => {
      finishOldSave({ ...first, revisionNumber: 2, title: "Saved first" });
    });
    expect(result.current.editingRunbook?.id).toBe("b");
    expect(result.current.runbooks.find((item) => item.id === "a")?.title).toBe(
      "Saved first",
    );
  });
});
