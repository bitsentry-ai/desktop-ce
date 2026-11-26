// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "@bitsentry-ce/components/markdown";
import { renderJsonEvidence } from "@bitsentry-ce/components/chat/JsonEvidenceBlock";
import { StructuredValue } from "@bitsentry-ce/components/runbook/StructuredValue";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; verdict?: string; columns?: string }) => {
      if (key === "common.structured.verdictCount") return `${String(options?.count)} ${String(options?.verdict)}`;
      if (options?.columns !== undefined) return `${key}:${options.columns}`;
      return options?.count === undefined ? key : `${key}:${String(options.count)}`;
    },
  }),
}));

afterEach(() => {
  cleanup();
});

function markdownTable(rows: number, row: (index: number) => string[]): string {
  return [
    "| CVE | Agent | Decision |",
    "|---|---|---|",
    ...Array.from({ length: rows }, (_, index) => `| ${row(index).join(" | ")} |`),
  ].join("\n");
}

describe("long tables in chat replies", () => {
  it("hides columns with no value in any row inline, names them, and keeps them for the full view", () => {
    const { container } = render(<MarkdownContent content={markdownTable(4, () => ["—", "-", "blocked"])} />);
    const visibleHeaders = [...container.querySelectorAll("th:not([data-empty-column])")].map((cell) => cell.textContent);
    expect(visibleHeaders).toEqual(["Decision"]);
    expect(container.querySelectorAll("th")).toHaveLength(3);
    expect(container.querySelectorAll("tbody td[data-empty-column]")).toHaveLength(8);
    expect(screen.getByText("common.markdown.emptyColumns:CVE, Agent")).toBeTruthy();
  });

  it("never folds rows that read the same but link to different places", () => {
    const { container } = render(
      <MarkdownContent
        content={markdownTable(3, (index) => [`[CVE-2026-1](https://example.com/${String(index)})`, "web-1", "blocked"])}
      />,
    );
    expect(container.querySelectorAll("tbody tr[data-repeat-row]")).toHaveLength(0);
  });

  it("keeps an empty column when too few rows say so", () => {
    const { container } = render(<MarkdownContent content={markdownTable(2, () => ["—", "web-1", "blocked"])} />);
    expect(container.querySelectorAll("th")).toHaveLength(3);
    expect(screen.queryByText(/common.markdown.emptyColumns/)).toBeNull();
  });

  it("starts a long table with its first rows and shows the rest on request", () => {
    const { container } = render(
      <MarkdownContent content={markdownTable(12, (index) => [`CVE-2026-${String(index)}`, "web-1", "blocked"])} />,
    );
    const wrapper = container.querySelector(".chat-markdown-table");
    expect(wrapper?.getAttribute("data-collapsed")).toBe("true");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(12);
    expect(container.querySelectorAll("tbody tr[data-overflow-row]")).toHaveLength(7);

    const toggle = screen.getByRole("button", { name: "common.markdown.showAllRows:12" });
    fireEvent.click(toggle);
    expect(wrapper?.hasAttribute("data-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "common.markdown.showFewerRows" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("folds a run of identical rows into its first row with a count", () => {
    const { container } = render(
      <MarkdownContent
        content={markdownTable(50, () => ["web-1", "blocked", "The finding has no CVE."])}
      />,
    );
    const wrapper = container.querySelector(".chat-markdown-table");
    expect(wrapper?.getAttribute("data-collapsed")).toBe("true");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(50);
    expect(container.querySelectorAll("tbody tr[data-repeat-row]")).toHaveLength(49);
    expect(container.querySelector("tbody tr:first-child .chat-markdown-row-repeat")?.textContent).toBe("×50");

    fireEvent.click(screen.getByRole("button", { name: "common.markdown.showAllRows:50" }));
    expect(wrapper?.hasAttribute("data-collapsed")).toBe(false);
  });

  it("only folds neighbouring rows, so the order of the reply stays", () => {
    const rows = ["a", "a", "b", "a"];
    const { container } = render(
      <MarkdownContent content={markdownTable(4, (index) => ["web-1", rows[index], "x"])} />,
    );
    expect(container.querySelectorAll("tbody tr[data-repeat-row]")).toHaveLength(1);
    const markers = [...container.querySelectorAll(".chat-markdown-row-repeat")].map((node) => node.textContent);
    expect(markers).toEqual(["×2"]);
  });

  it("shows five distinct rows of a long table with repeats", () => {
    const { container } = render(
      <MarkdownContent
        content={markdownTable(24, (index) => [`CVE-${String(Math.floor(index / 2))}`, "web-1", "blocked"])}
      />,
    );
    const shown = [...container.querySelectorAll("tbody tr")].filter(
      (row) => !row.hasAttribute("data-repeat-row") && !row.hasAttribute("data-overflow-row"),
    );
    expect(shown).toHaveLength(5);
  });

  it("leaves a short table as it is", () => {
    const { container } = render(
      <MarkdownContent content={markdownTable(10, (index) => [`CVE-${String(index)}`, "web-1", "blocked"])} />,
    );
    expect(container.querySelector(".chat-markdown-table")?.hasAttribute("data-collapsed")).toBe(false);
    expect(screen.queryByRole("button", { name: /showAllRows/ })).toBeNull();
  });
});

describe("lists of records", () => {
  it("folds identical records into one entry with a count", () => {
    const decision = { eligibility: "blocked", reason: "invalid_finding", explanation: "The finding has no CVE." };
    render(
      <MarkdownContent
        content={"```json\n" + JSON.stringify(Array.from({ length: 50 }, () => decision)) + "\n```"}
        renderJsonBlock={renderJsonEvidence}
      />,
    );
    expect(screen.getByText("50 blocked").textContent).toBe("50 blocked · Invalid finding");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("×50")).toBeTruthy();
    // The summary already states the verdict and reason, so each record keeps only the rest.
    expect(screen.queryByText("Eligibility")).toBeNull();
    expect(screen.getByText("The finding has no CVE.")).toBeTruthy();
  });

  it("sums mixed verdicts and keeps each record's own verdict", () => {
    render(
      <MarkdownContent
        content={
          "```json\n" +
          JSON.stringify([
            { eligibility: "blocked", reason: "invalid_finding", explanation: "The Wazuh finding is missing a valid CVE identifier, so no playbook is made." },
            { eligibility: "blocked", reason: "invalid_finding", explanation: "The Wazuh finding is missing a valid CVE identifier, so no playbook is made." },
            { eligibility: "eligible", reason: "invalid_finding", explanation: "The vendor already ships a fixed package for this release, so a playbook can follow." },
          ]) +
          "\n```"
        }
        renderJsonBlock={renderJsonEvidence}
      />,
    );
    expect(screen.getByText("2 blocked · 1 eligible")).toBeTruthy();
    expect(screen.getAllByText("Eligibility").length).toBeGreaterThan(0);
  });

  it("shows the first five entries of a long list with no wrapping index", () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      note: `A long note about item ${String(index)} that reads as prose rather than a table cell value.`,
    }));
    const { container } = render(<StructuredValue value={items} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(container.querySelector("li > span")?.className).toContain("whitespace-nowrap");

    fireEvent.click(screen.getByRole("button", { name: "common.structured.showAllItems:8" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "common.structured.showFewer" })).toBeTruthy();
  });

  it("folds only neighbouring identical items and lists every item in order on request", () => {
    const a = { note: "First kind of record, long enough to read as prose and not a table cell." };
    const b = { note: "Second kind of record, also long enough to read as prose and not a table cell." };
    render(<StructuredValue value={[a, a, b, a]} />);
    const folded = screen.getAllByRole("listitem");
    expect(folded).toHaveLength(3);
    expect(folded.map((item) => item.querySelector("span")?.textContent)).toEqual(["×2", "×1", "×1"]);

    fireEvent.click(screen.getByRole("button", { name: "common.structured.showAllItems:4" }));
    const all = screen.getAllByRole("listitem");
    expect(all.map((item) => item.querySelector("span")?.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(all[3].textContent).toContain("First kind of record");
  });

  it("does not hide a single extra entry behind a button", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      note: `A long note about item ${String(index)} that reads as prose rather than a table cell value.`,
    }));
    render(<StructuredValue value={items} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("JSON carried as text", () => {
  it("folds a long JSON string to its size and opens it as readable values", () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({ cveId: `CVE-2024-${String(1000 + index)}`, packageName: "Jinja2" }));
    render(<StructuredValue value={{ pluginId: "linux-cve-status", findings: JSON.stringify(findings) }} />);
    expect(screen.queryByText(/"cveId"/)).toBeNull();
    const toggle = screen.getByRole("button", { name: /items.*12/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("CVE-2024-1000")).toBeTruthy();
  });

  it("keeps a short JSON string as text", () => {
    render(<StructuredValue value={{ note: '{"a":1}' }} />);
    expect(screen.getByText('{"a":1}')).toBeTruthy();
  });
});
