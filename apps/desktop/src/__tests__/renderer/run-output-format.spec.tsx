// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectRunOutputFormat,
  parseJsonContainer,
  runOutputPreview,
  stringifyForOutput,
  truncateLines,
} from "@bitsentry-ce/components/runbook/runOutputFormat";
import {
  RUN_OUTPUT_MAX_VISIBLE_LINES,
  RunOutputBlock,
} from "@bitsentry-ce/components/runbook/RunOutputBlock";
import { ResultsDetailPanels } from "@bitsentry-ce/components/runbook/ResultsDetailPanels";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${String(options.count)}`,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("parseJsonContainer", () => {
  it("parses objects and arrays", () => {
    expect(parseJsonContainer('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonContainer("  [1, 2]  ")).toEqual([1, 2]);
  });

  it("unwraps JSON that was serialized into a string", () => {
    expect(parseJsonContainer(JSON.stringify(JSON.stringify({ a: [1] })))).toEqual({
      a: [1],
    });
  });

  it("rejects scalars, plain strings and invalid JSON", () => {
    expect(parseJsonContainer("42")).toBeNull();
    expect(parseJsonContainer('"hello"')).toBeNull();
    expect(parseJsonContainer("{not json}")).toBeNull();
    expect(parseJsonContainer("[link](https://example.com)")).toBeNull();
  });
});

describe("detectRunOutputFormat", () => {
  it("treats blank output as empty", () => {
    expect(detectRunOutputFormat("  \n ")).toEqual({ kind: "empty" });
  });

  it("pretty-prints JSON and expands escaped newlines for display only", () => {
    const raw = JSON.stringify({ description: "line one\nline two" });
    const format = detectRunOutputFormat(raw);

    expect(format.kind).toBe("json");
    if (format.kind !== "json") return;
    expect(format.lead).toBe("");
    expect(format.display).toBe('{\n  "description": "line one\nline two"\n}');
    expect(JSON.parse(format.copyText)).toEqual({ description: "line one\nline two" });
  });

  it("splits a lead sentence from a trailing JSON payload", () => {
    const payload = { findings: [{ id: "CVE-1", note: "**Prerequisites** hold" }] };
    const raw = `Fetched 1 of 103 findings.\n\n${JSON.stringify(payload)}`;
    const format = detectRunOutputFormat(raw);

    expect(format.kind).toBe("json");
    if (format.kind !== "json") return;
    expect(format.lead).toBe("Fetched 1 of 103 findings.");
    expect(format.display).toContain('  "findings": [');
    expect(format.copyText.startsWith("Fetched 1 of 103 findings.\n\n{")).toBe(true);
  });

  it("keeps Markdown and plain text apart", () => {
    expect(detectRunOutputFormat("## Root cause\n- disk full").kind).toBe("markdown");
    expect(detectRunOutputFormat("Pages free: 76905.\nPages active: 602156.").kind).toBe(
      "text",
    );
  });

  it("falls back to text when the JSON-looking tail is not valid JSON", () => {
    expect(detectRunOutputFormat("summary\n{ broken").kind).toBe("text");
  });
});

describe("runOutputPreview", () => {
  it("keeps the lead sentence apart from the pretty-printed payload", () => {
    expect(runOutputPreview('Fetched 2 rows.\n{"rows":[1,2]}', 10)).toEqual({
      lead: "Fetched 2 rows.",
      body: '{\n  "rows": [\n    1,\n    2\n  ]\n}',
      json: true,
    });
  });

  it("caps the body at the line limit", () => {
    const value = Array.from({ length: 30 }, (_, index) => `line ${String(index)}`).join("\n");
    const preview = runOutputPreview(value, 5);
    expect(preview?.json).toBe(false);
    expect(preview?.body.split("\n")).toHaveLength(5);
  });

  it("returns null for blank output", () => {
    expect(runOutputPreview("  ", 5)).toBeNull();
  });
});

describe("stringifyForOutput", () => {
  it("returns an empty string for missing values", () => {
    expect(stringifyForOutput(undefined)).toBe("");
    expect(stringifyForOutput(null)).toBe("");
    expect(stringifyForOutput({ host: "db-1" })).toBe('{"host":"db-1"}');
  });
});

describe("truncateLines", () => {
  it("keeps short text whole", () => {
    expect(truncateLines("a\nb", 2)).toEqual({ text: "a\nb", totalLines: 2, truncated: false });
  });

  it("cuts after the line limit and reports the total", () => {
    expect(truncateLines("a\nb\nc\nd", 2)).toEqual({ text: "a\nb", totalLines: 4, truncated: true });
  });
});

describe("RunOutputBlock", () => {
  it("renders JSON as readable fields and keeps a copy button", () => {
    render(<RunOutputBlock value='{"a":1}' emptyMessage="empty" />);

    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("A")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "common.results.copyOutput" })).toBeTruthy();
  });

  it("shows the empty message for blank output", () => {
    render(<RunOutputBlock value="" emptyMessage="Nothing captured" />);
    expect(screen.getByText("Nothing captured")).toBeTruthy();
  });

  it("caps long output until expanded", () => {
    const total = RUN_OUTPUT_MAX_VISIBLE_LINES + 50;
    const value = Array.from({ length: total }, (_, index) => `line ${String(index)}`).join("\n");
    render(<RunOutputBlock value={value} emptyMessage="empty" />);

    const pre = document.querySelector("pre");
    expect(pre?.textContent?.split("\n")).toHaveLength(RUN_OUTPUT_MAX_VISIBLE_LINES);

    fireEvent.click(screen.getByText(`common.results.showAllLines:${String(total)}`));
    expect(document.querySelector("pre")?.textContent?.split("\n")).toHaveLength(total);
  });
});

describe("ResultsDetailPanels", () => {
  it("moves between panels with the arrow keys", () => {
    const onChange = vi.fn();
    render(
      <ResultsDetailPanels
        activePanel="summary"
        onActivePanelChange={onChange}
        summary={<div>summary body</div>}
        steps={<div>steps body</div>}
        output={<div>output body</div>}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);

    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("steps");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("output");
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("output");
  });
});
