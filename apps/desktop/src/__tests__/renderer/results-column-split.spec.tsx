// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESULTS_COLUMN_SPLIT,
  LEGACY_RESULTS_COLUMN_SPLIT_STORAGE_KEY,
  RESULTS_COLUMN_LIMITS,
  RESULTS_COLUMN_SPLIT_STORAGE_KEY,
  columnSplitForKey,
  normalizeColumnSplit,
  readColumnSplit,
  resizeColumnSplit,
  writeColumnSplit,
} from "@bitsentry-ce/components/runbook/resultsColumnSplit";
import { ResultsDetailPanels } from "@bitsentry-ce/components/runbook/ResultsDetailPanels";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options === undefined ? key : `${key}:${Object.values(options).join("|")}`,
  }),
}));

// jsdom has no PointerEvent, so pointer events would arrive without a pointerId.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    values,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("PointerEvent", TestPointerEvent);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeColumnSplit", () => {
  it("accepts two pixel widths and clamps them to the column limits", () => {
    expect(normalizeColumnSplit([300, 200])).toEqual([300, 200]);
    expect(normalizeColumnSplit([100, 900])).toEqual([
      RESULTS_COLUMN_LIMITS[0].min,
      RESULTS_COLUMN_LIMITS[1].max,
    ]);
  });

  it("rejects anything else, including the old three-percentage split", () => {
    expect(normalizeColumnSplit(null)).toBeNull();
    expect(normalizeColumnSplit({ 0: 300, 1: 200 })).toBeNull();
    expect(normalizeColumnSplit([26, 24, 50])).toBeNull();
    expect(normalizeColumnSplit([300, "200"])).toBeNull();
    expect(normalizeColumnSplit([300, Number.NaN])).toBeNull();
  });
});

describe("resizeColumnSplit", () => {
  it("resizes the column before the divider and leaves the other alone", () => {
    expect(resizeColumnSplit([280, 240], 0, 40)).toEqual([320, 240]);
    expect(resizeColumnSplit([280, 240], 1, -30)).toEqual([280, 210]);
  });

  it("stops at the column limits", () => {
    expect(resizeColumnSplit([280, 240], 0, 1000)).toEqual([
      RESULTS_COLUMN_LIMITS[0].max,
      240,
    ]);
    expect(resizeColumnSplit([280, 240], 1, -1000)).toEqual([
      280,
      RESULTS_COLUMN_LIMITS[1].min,
    ]);
  });

  it("rounds to whole pixels", () => {
    expect(resizeColumnSplit([280, 240], 0, 1.4)).toEqual([281, 240]);
  });
});

describe("columnSplitForKey", () => {
  it("steps with the arrows and jumps to the limits with Home and End", () => {
    expect(columnSplitForKey([280, 240], 0, "ArrowRight")).toEqual([296, 240]);
    expect(columnSplitForKey([280, 240], 0, "ArrowLeft")).toEqual([264, 240]);
    expect(columnSplitForKey([280, 240], 1, "Home")).toEqual([
      280,
      RESULTS_COLUMN_LIMITS[1].min,
    ]);
    expect(columnSplitForKey([280, 240], 1, "End")).toEqual([
      280,
      RESULTS_COLUMN_LIMITS[1].max,
    ]);
    expect(columnSplitForKey([280, 240], 0, "Enter")).toBeNull();
  });
});

describe("split persistence", () => {
  it("round-trips a split through storage", () => {
    const storage = memoryStorage();
    writeColumnSplit([300, 200], storage);
    expect(storage.values.get(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[300,200]");
    expect(readColumnSplit(storage)).toEqual([300, 200]);
  });

  it("starts from the pixel defaults and drops the old percentage split", () => {
    expect(DEFAULT_RESULTS_COLUMN_SPLIT).toEqual([300, 300]);
    const storage = memoryStorage({
      [LEGACY_RESULTS_COLUMN_SPLIT_STORAGE_KEY]: "[26,24,50]",
    });
    expect(readColumnSplit(storage)).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
    writeColumnSplit([300, 200], storage);
    expect(storage.values.has(LEGACY_RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe(false);
  });

  it("falls back to the default for missing, corrupt or invalid values", () => {
    expect(readColumnSplit(memoryStorage())).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
    expect(
      readColumnSplit(memoryStorage({ [RESULTS_COLUMN_SPLIT_STORAGE_KEY]: "{oops" })),
    ).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
    expect(
      readColumnSplit(memoryStorage({ [RESULTS_COLUMN_SPLIT_STORAGE_KEY]: "[90,5,5]" })),
    ).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
    expect(readColumnSplit(null)).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
  });

  it("survives storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readColumnSplit(throwing)).toEqual(DEFAULT_RESULTS_COLUMN_SPLIT);
    expect(() => {
      writeColumnSplit([300, 200], throwing);
    }).not.toThrow();
  });
});

function renderPanels() {
  return render(
    <ResultsDetailPanels
      activePanel="summary"
      onActivePanelChange={vi.fn()}
      summary={<div>summary body</div>}
      steps={<div>steps body</div>}
      output={<div>output body</div>}
    />,
  );
}

function columnWidths(container: HTMLElement) {
  const columns = container.querySelector<HTMLElement>("[style]");
  return [
    columns?.style.getPropertyValue("--results-col-summary"),
    columns?.style.getPropertyValue("--results-col-steps"),
  ];
}

describe("ResultsDetailPanels column dividers", () => {
  it("starts from the default pixel widths with two labelled separators", () => {
    const { container } = renderPanels();

    expect(columnWidths(container)).toEqual(["300px", "300px"]);
    const separators = screen.getAllByRole("separator", { hidden: true });
    expect(separators).toHaveLength(2);
    expect(separators[0].getAttribute("aria-orientation")).toBe("vertical");
    expect(separators[0].getAttribute("aria-valuenow")).toBe("300");
    expect(separators[0].getAttribute("aria-valuemin")).toBe(
      String(RESULTS_COLUMN_LIMITS[0].min),
    );
    expect(separators[0].getAttribute("aria-valuemax")).toBe(
      String(RESULTS_COLUMN_LIMITS[0].max),
    );
    expect(separators[0].getAttribute("tabindex")).toBe("0");
    expect(separators[0].getAttribute("aria-label")).toBe(
      "common.results.resizeColumns:common.results.summary|common.results.steps",
    );
  });

  it("restores a saved split", () => {
    window.localStorage.setItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY, "[300,200]");
    const { container } = renderPanels();
    expect(columnWidths(container)).toEqual(["300px", "200px"]);
  });

  it("resizes with the keyboard and saves the split", () => {
    const { container } = renderPanels();
    const [, stepsDivider] = screen.getAllByRole("separator", { hidden: true });

    fireEvent.keyDown(stepsDivider, { key: "ArrowRight" });
    expect(columnWidths(container)).toEqual(["300px", "316px"]);
    expect(stepsDivider.getAttribute("aria-valuenow")).toBe("316");
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[300,316]");

    fireEvent.doubleClick(stepsDivider);
    expect(columnWidths(container)).toEqual(["300px", "300px"]);
  });

  it("resizes by dragging and saves when the pointer is released", () => {
    const { container } = renderPanels();
    const [summaryDivider] = screen.getAllByRole("separator", { hidden: true });
    summaryDivider.setPointerCapture = vi.fn();
    summaryDivider.hasPointerCapture = vi.fn(() => true);
    summaryDivider.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(summaryDivider, { button: 0, pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(summaryDivider, { pointerId: 1, clientX: 340 });
    expect(columnWidths(container)).toEqual(["340px", "300px"]);
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBeNull();

    fireEvent.pointerUp(summaryDivider, { pointerId: 1, clientX: 340 });
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[340,300]");
    expect(summaryDivider.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
