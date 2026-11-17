// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESULTS_COLUMN_SPLIT,
  RESULTS_COLUMN_MIN_PERCENT,
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
  it("accepts three widths that add up to 100 and respect the minimum", () => {
    expect(normalizeColumnSplit([30, 20, 50])).toEqual([30, 20, 50]);
    expect(normalizeColumnSplit([33.3, 33.3, 33.4])).toEqual([33.3, 33.3, 33.4]);
  });

  it("rejects anything else", () => {
    expect(normalizeColumnSplit(null)).toBeNull();
    expect(normalizeColumnSplit({ 0: 30, 1: 20, 2: 50 })).toBeNull();
    expect(normalizeColumnSplit([50, 50])).toBeNull();
    expect(normalizeColumnSplit([30, "20", 50])).toBeNull();
    expect(normalizeColumnSplit([30, Number.NaN, 50])).toBeNull();
    expect(normalizeColumnSplit([30, 30, 30])).toBeNull();
    expect(normalizeColumnSplit([10, 40, 50])).toBeNull();
  });
});

describe("resizeColumnSplit", () => {
  it("trades width between the two columns beside the divider", () => {
    expect(resizeColumnSplit([26, 24, 50], 0, 4)).toEqual([30, 20, 50]);
    expect(resizeColumnSplit([26, 24, 50], 1, -6)).toEqual([26, 18, 56]);
  });

  it("stops at the minimum width on either side", () => {
    expect(resizeColumnSplit([26, 24, 50], 0, 40)).toEqual([
      50 - RESULTS_COLUMN_MIN_PERCENT,
      RESULTS_COLUMN_MIN_PERCENT,
      50,
    ]);
    expect(resizeColumnSplit([26, 24, 50], 1, 40)).toEqual([
      26,
      74 - RESULTS_COLUMN_MIN_PERCENT,
      RESULTS_COLUMN_MIN_PERCENT,
    ]);
  });

  it("rounds to a tenth of a percent", () => {
    expect(resizeColumnSplit([26, 24, 50], 0, 1.234)).toEqual([27.2, 22.8, 50]);
  });
});

describe("columnSplitForKey", () => {
  it("steps with the arrows and jumps to the limits with Home and End", () => {
    expect(columnSplitForKey([26, 24, 50], 0, "ArrowRight")).toEqual([28, 22, 50]);
    expect(columnSplitForKey([26, 24, 50], 0, "ArrowLeft")).toEqual([24, 26, 50]);
    expect(columnSplitForKey([26, 24, 50], 1, "Home")).toEqual([26, 18, 56]);
    expect(columnSplitForKey([26, 24, 50], 1, "End")).toEqual([26, 56, 18]);
    expect(columnSplitForKey([26, 24, 50], 0, "Enter")).toBeNull();
  });
});

describe("split persistence", () => {
  it("round-trips a split through storage", () => {
    const storage = memoryStorage();
    writeColumnSplit([30, 20, 50], storage);
    expect(storage.values.get(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[30,20,50]");
    expect(readColumnSplit(storage)).toEqual([30, 20, 50]);
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
      writeColumnSplit([30, 20, 50], throwing);
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
    columns?.style.getPropertyValue("--results-col-output"),
  ];
}

describe("ResultsDetailPanels column dividers", () => {
  it("starts from the default split with two labelled separators", () => {
    const { container } = renderPanels();

    expect(columnWidths(container)).toEqual(["26%", "24%", "50%"]);
    const separators = screen.getAllByRole("separator", { hidden: true });
    expect(separators).toHaveLength(2);
    expect(separators[0].getAttribute("aria-orientation")).toBe("vertical");
    expect(separators[0].getAttribute("aria-valuenow")).toBe("26");
    expect(separators[0].getAttribute("aria-valuemin")).toBe("18");
    expect(separators[0].getAttribute("aria-valuemax")).toBe("32");
    expect(separators[0].getAttribute("tabindex")).toBe("0");
    expect(separators[0].getAttribute("aria-label")).toBe(
      "common.results.resizeColumns:common.results.summary|common.results.steps",
    );
  });

  it("restores a saved split", () => {
    window.localStorage.setItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY, "[30,20,50]");
    const { container } = renderPanels();
    expect(columnWidths(container)).toEqual(["30%", "20%", "50%"]);
  });

  it("resizes with the keyboard and saves the split", () => {
    const { container } = renderPanels();
    const [, stepsDivider] = screen.getAllByRole("separator", { hidden: true });

    fireEvent.keyDown(stepsDivider, { key: "ArrowRight" });
    expect(columnWidths(container)).toEqual(["26%", "26%", "48%"]);
    expect(stepsDivider.getAttribute("aria-valuenow")).toBe("26");
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[26,26,48]");

    fireEvent.doubleClick(stepsDivider);
    expect(columnWidths(container)).toEqual(["26%", "24%", "50%"]);
  });

  it("resizes by dragging and saves when the pointer is released", () => {
    const { container } = renderPanels();
    const columns = container.querySelector<HTMLElement>("[style]");
    if (columns === null) throw new Error("columns not rendered");
    vi.spyOn(columns, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const [summaryDivider] = screen.getAllByRole("separator", { hidden: true });
    summaryDivider.setPointerCapture = vi.fn();
    summaryDivider.hasPointerCapture = vi.fn(() => true);
    summaryDivider.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(summaryDivider, { button: 0, pointerId: 1, clientX: 260 });
    fireEvent.pointerMove(summaryDivider, { pointerId: 1, clientX: 300 });
    expect(columnWidths(container)).toEqual(["30%", "20%", "50%"]);
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBeNull();

    fireEvent.pointerUp(summaryDivider, { pointerId: 1, clientX: 300 });
    expect(window.localStorage.getItem(RESULTS_COLUMN_SPLIT_STORAGE_KEY)).toBe("[30,20,50]");
    expect(summaryDivider.releasePointerCapture).toHaveBeenCalledWith(1);
  });
});
