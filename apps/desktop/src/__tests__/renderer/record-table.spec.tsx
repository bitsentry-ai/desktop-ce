// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_TABLE_MAX_ROWS,
  findRecordTable,
  recordColumnLabel,
  severityTone,
} from "@bitsentry-ce/components/runbook/recordTable";
import { RunOutputBlock } from "@bitsentry-ce/components/runbook/RunOutputBlock";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${String(options.count)}`,
  }),
}));

afterEach(() => {
  cleanup();
});

function finding(index: number, severity: string) {
  return {
    "agent.id": "004",
    "agent.name": "bitsentry-telemetry",
    "package.name": `pkg-${String(index)}`,
    "package.version": `1.${String(index)}.0`,
    "vulnerability.id": `CVE-2026-${String(1000 + index)}`,
    "vulnerability.severity": severity,
    "vulnerability.score.base": 9 - index / 10,
    "vulnerability.description": "A long explanation of the issue. ".repeat(6),
  };
}

const payload = {
  findings: [finding(1, "Critical"), finding(2, "High"), finding(3, "Medium")],
  total: 103,
  retrievedAt: "2026-10-29T07:39:00Z",
};

describe("findRecordTable", () => {
  it("picks the record list and the columns that tell records apart", () => {
    const table = findRecordTable(payload);
    expect(table?.name).toBe("findings");
    expect(table?.total).toBe(3);
    expect(table?.columns).toEqual([
      "vulnerability.severity",
      "vulnerability.id",
      "package.name",
      "package.version",
      "vulnerability.score.base",
    ]);
  });

  it("flattens nested records into dotted columns", () => {
    const table = findRecordTable([
      { host: { name: "a" }, check: { status: "ok" } },
      { host: { name: "b" }, check: { status: "failed" } },
    ]);
    expect(table?.name).toBeNull();
    expect(table?.columns).toEqual(["host.name", "check.status"]);
  });

  it("returns null for payloads that are not record lists", () => {
    expect(findRecordTable({ a: 1 })).toBeNull();
    expect(findRecordTable([{ a: 1 }])).toBeNull();
    expect(findRecordTable([1, 2, 3])).toBeNull();
    expect(findRecordTable([{ a: 1 }, { a: 1 }])).toBeNull();
  });

  it("caps the rows it keeps but reports the full count", () => {
    const many = Array.from({ length: RECORD_TABLE_MAX_ROWS + 5 }, (_, index) => ({
      id: String(index),
      status: index % 2 === 0 ? "ok" : "failed",
    }));
    const table = findRecordTable(many);
    expect(table?.rows).toHaveLength(RECORD_TABLE_MAX_ROWS);
    expect(table?.total).toBe(RECORD_TABLE_MAX_ROWS + 5);
  });
});

describe("recordColumnLabel and severityTone", () => {
  it("keeps the parent segment for generic or shared names", () => {
    const columns = ["vulnerability.severity", "vulnerability.id", "package.name"];
    expect(recordColumnLabel("vulnerability.severity", columns)).toBe("severity");
    expect(recordColumnLabel("vulnerability.id", columns)).toBe("vulnerability.id");
    expect(recordColumnLabel("package.name", columns)).toBe("package.name");
  });

  it("marks high and critical severities strongest", () => {
    expect(severityTone("vulnerability.severity", "Critical")).toBe("critical");
    expect(severityTone("vulnerability.severity", "medium")).toBe("warning");
    expect(severityTone("vulnerability.severity", "Low")).toBeNull();
    expect(severityTone("package.name", "Critical")).toBeNull();
  });
});

describe("RunOutputBlock record table", () => {
  it("leads with the table and switches to the raw JSON", () => {
    render(<RunOutputBlock value={JSON.stringify(payload)} emptyMessage="empty" />);

    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("columnheader", { name: "severity" })).toBeTruthy();
    expect(screen.getByText("CVE-2026-1001")).toBeTruthy();
    expect(document.querySelector("pre")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.queryByRole("table")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain('"findings"');
    expect(screen.getByRole("button", { name: "common.results.wrapLines" })).toBeTruthy();
  });

  it("keeps plain JSON objects in the JSON view", () => {
    render(<RunOutputBlock value='{"a":1}' emptyMessage="empty" />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "common.results.viewTable" })).toBeNull();
  });
});
