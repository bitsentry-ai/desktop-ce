// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredValue } from "@bitsentry-ce/components/runbook/StructuredValue";
import { renderJsonEvidence } from "@bitsentry-ce/components/chat/JsonEvidenceBlock";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values === undefined ? key : `${key}(${Object.values(values).join(",")})`,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("structured values", () => {
  it("shows an object as labelled rows, nested objects indented, and never as raw JSON", () => {
    const { container } = render(
      <StructuredValue value={{ eligibility: "vendor_fix_pending", agentId: "004", package: { name: "linux-image", version: "6.8.0" } }} />,
    );
    expect(screen.getByText("Eligibility")).toBeTruthy();
    expect(screen.getByText("Vendor fix pending")).toBeTruthy();
    expect(screen.getByText(/^Agent ID$/i)).toBeTruthy();
    expect(screen.getByText("linux-image")).toBeTruthy();
    expect(container.textContent).not.toContain("{");
    expect(container.textContent).not.toContain('"');
  });

  it("lists plain values with commas and says yes or no for booleans", () => {
    render(<StructuredValue value={{ hosts: ["web-1", "web-2"], dryRun: true }} />);
    expect(screen.getByText("web-1")).toBeTruthy();
    expect(screen.getByText("web-2")).toBeTruthy();
    expect(screen.getByText("common.structured.yes")).toBeTruthy();
  });

  it("shows the first fields of a long object and the rest on request", () => {
    const value = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field${String(index)}`, `value ${String(index)}`]));
    render(<StructuredValue value={value} limit={6} />);
    expect(screen.queryByText("value 8")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.structured.showAllFields(9)" }));
    expect(screen.getByText("value 8")).toBeTruthy();
  });
});

describe("JSON in a chat reply", () => {
  it("renders a JSON object as fields with no raw JSON toggle", () => {
    const code = JSON.stringify({ eligibility: "blocked", reason: "vendor_fix_pending", cveId: "CVE-2026-1" });
    const { container } = render(<>{renderJsonEvidence(code, <pre>{code}</pre>, "View JSON")}</>);
    expect(screen.getByText("Blocked").textContent).toBe("Blocked · Vendor fix pending");
    expect(screen.getByText("CVE-2026-1")).toBeTruthy();
    expect(screen.queryByText("View JSON")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("keeps text that does not parse as JSON as a code block", () => {
    render(<>{renderJsonEvidence("{ not json", <pre>{"{ not json"}</pre>, "View JSON")}</>);
    expect(screen.getByText("{ not json")).toBeTruthy();
  });
});
