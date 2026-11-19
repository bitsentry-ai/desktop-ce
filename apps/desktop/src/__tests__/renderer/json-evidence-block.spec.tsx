// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "@bitsentry-ce/components/markdown";
import { renderJsonEvidence } from "@bitsentry-ce/components/chat/JsonEvidenceBlock";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${String(options.count)}`,
  }),
}));

afterEach(() => {
  cleanup();
});

function renderJson(json: unknown) {
  const content = "Plugin evaluation\n\n```json\n" + JSON.stringify(json, null, 2) + "\n```";
  return render(
    <MarkdownContent
      content={content}
      collapsedJsonLabel="View JSON"
      renderJsonBlock={renderJsonEvidence}
    />,
  );
}

describe("JSON blocks in chat replies", () => {
  it("shows an object as labelled fields with no raw JSON view", () => {
    const { container } = renderJson({
      eligibility: "blocked",
      reason: "vendor_fix_pending",
      vendorStatus: "pending",
    });
    expect(screen.getByText("Eligibility")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText("Vendor fix pending")).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
    expect(screen.queryByText("View JSON")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("opens a list of records as a table", () => {
    renderJson([
      { cveId: "CVE-2026-1", package: "openssl", status: "pending" },
      { cveId: "CVE-2026-2", package: "glibc", status: "fixed" },
    ]);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("CVE-2026-2")).toBeTruthy();
  });

  it("summarises a list that holds a single record as that record's fields", () => {
    renderJson([{ eligibility: "blocked", reason: "vendor_fix_pending", cveId: "CVE-2026-89526" }]);
    expect(screen.getByText("Eligibility")).toBeTruthy();
    expect(screen.getByText("Vendor fix pending")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a list of plain values as words, not JSON", () => {
    const { container } = renderJson(["a", "b"]);
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("reads an untagged code block that holds JSON the same way", () => {
    const content = "Result\n\n```\n" + JSON.stringify({ host: "web-1", healthy: true }) + "\n```";
    render(<MarkdownContent content={content} renderJsonBlock={renderJsonEvidence} />);
    expect(screen.getByText("Host")).toBeTruthy();
    expect(screen.getByText("web-1")).toBeTruthy();
  });
});
