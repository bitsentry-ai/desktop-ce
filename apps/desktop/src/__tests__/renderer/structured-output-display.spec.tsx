// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StructuredOutputDisplay } from "@bitsentry-ce/components/runbook/StructuredOutputDisplay";
import {
  expandJsonWhitespaceEscapes,
  formatJsonBlockForDisplay,
  formatStructuredValue,
} from "@bitsentry-ce/components/lib/jsonDisplay";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

// Mirrors what an external-source query step captures. The Sentry formatter
// joins these with "\n\n" and keeps an empty separator entry, so the captured
// text carries a blank line between every header row plus a three-blank-line
// gap before the first issue.
const EVIDENCE_QUERY_OUTPUT = [
  "External Source Query Results",
  "Source: Sentry Sandbox API",
  "Provider: sentry",
  "Query: issue:SANDBOX-API-C",
  "Returned: 1 issue(s)",
  "",
  ["1. Error: Cannot find module", "Issue: SANDBOX-API-C"].join("\n"),
].join("\n\n");

const EVIDENCE_QUERIES = [
  {
    sourceType: "sentry",
    sourceName: "Sentry Sandbox API",
    query: "issue:SANDBOX-API-C",
    resultCount: 1,
    hasMore: false,
    output: EVIDENCE_QUERY_OUTPUT,
  },
];

describe("expandJsonWhitespaceEscapes", () => {
  it("expands the escapes JSON.stringify introduces for nested newlines", () => {
    const serialized = JSON.stringify({ output: "first\nsecond" }, null, 2);

    expect(serialized).toContain("first\\nsecond");
    expect(expandJsonWhitespaceEscapes(serialized)).toContain("first\nsecond");
  });

  it("leaves literal backslash sequences alone", () => {
    // The source string holds a backslash followed by "n", not a newline.
    const serialized = JSON.stringify({ pattern: "line\\nbreak" }, null, 2);

    expect(expandJsonWhitespaceEscapes(serialized)).toContain("line\\\\nbreak");
  });

  it("expands only the real escapes when both forms appear together", () => {
    const serialized = JSON.stringify(
      { mixed: "real\nbreak and literal \\n token" },
      null,
      2,
    );
    const expanded = expandJsonWhitespaceEscapes(serialized);

    expect(expanded).toContain("real\nbreak");
    expect(expanded).toContain("literal \\\\n token");
  });

  it("expands carriage returns and tabs", () => {
    const serialized = JSON.stringify({ value: "a\r\nb\tc" }, null, 2);
    const expanded = expandJsonWhitespaceEscapes(serialized);

    expect(expanded).toContain("a\r\nb\tc");
  });
});

describe("formatStructuredValue", () => {
  it("renders nested multi-line strings as text while keeping the JSON shape", () => {
    const formatted = formatStructuredValue(EVIDENCE_QUERIES);

    expect(formatted).not.toContain("\\n");
    expect(formatted).toContain(
      "External Source Query Results\nSource: Sentry Sandbox API",
    );
    expect(formatted).toContain('"sourceType": "sentry"');
    expect(formatted).toContain('"resultCount": 1');
  });

  it("drops the blank lines that pad a captured block", () => {
    const formatted = formatStructuredValue(EVIDENCE_QUERIES);

    // The formatter separates every header row with a blank line and expands
    // its empty separator entry into three.
    expect(EVIDENCE_QUERY_OUTPUT).toContain("\n\n\n\n");
    expect(formatted).not.toMatch(/\n\s*\n/);
    expect(formatted).toContain(
      "Returned: 1 issue(s)\n1. Error: Cannot find module",
    );
    expect(formatted).toContain("Provider: sentry\nQuery: issue:SANDBOX-API-C");
  });

  it("keeps every content line when blank lines are removed", () => {
    const formatted = formatStructuredValue(EVIDENCE_QUERIES);

    for (const line of EVIDENCE_QUERY_OUTPUT.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(formatted).toContain(line);
    }
  });

  it("parses and formats a value that arrives as a JSON string", () => {
    const formatted = formatStructuredValue(JSON.stringify(EVIDENCE_QUERIES));

    expect(formatted).not.toContain("\\n");
    expect(formatted).not.toMatch(/\n\s*\n/);
  });

  it("returns plain strings verbatim, including author-written backslash-n", () => {
    expect(formatStructuredValue("grep -E 'a\\nb'")).toBe("grep -E 'a\\nb'");
    expect(formatStructuredValue("already\nmultiline")).toBe("already\nmultiline");
  });

  it("keeps short escape-free values on a single line", () => {
    expect(formatStructuredValue(["sentry"])).toBe('["sentry"]');
    expect(formatStructuredValue(42)).toBe("42");
    expect(formatStructuredValue(null)).toBe("null");
  });

  it("expands short values that would otherwise show a literal escape", () => {
    expect(formatStructuredValue({ a: "x\ny" })).toContain("x\ny");
  });

  it("leaves a malformed JSON string untouched", () => {
    expect(formatStructuredValue('{"broken": ')).toBe('{"broken": ');
  });
});

describe("formatJsonBlockForDisplay", () => {
  it("expands nested newlines in step input blocks", () => {
    const formatted = formatJsonBlockForDisplay({
      command: "set -e\necho ok",
    });

    expect(formatted).not.toContain("\\n");
    expect(formatted).toContain("set -e\necho ok");
  });

  it("returns an empty string when there is nothing to render", () => {
    expect(formatJsonBlockForDisplay(null)).toBe("");
    expect(formatJsonBlockForDisplay(undefined)).toBe("");
  });
});

describe("StructuredOutputDisplay", () => {
  function renderEvidenceOutput() {
    return render(
      <StructuredOutputDisplay
        structuredOutput={{
          verificationMethod: "source_evidence",
          evidenceSourcesUsed: ["sentry"],
          evidenceQueries: EVIDENCE_QUERIES,
        }}
      />,
    );
  }

  it("renders evidence query output without literal newline escapes", () => {
    const { container } = renderEvidenceOutput();
    const text = container.textContent ?? "";

    expect(text).not.toContain("\\n");
    expect(text).toContain(
      "External Source Query Results\nSource: Sentry Sandbox API",
    );
    expect(text).toContain('"sourceType": "sentry"');
    expect(text).toContain('["sentry"]');
    expect(text).toContain("source_evidence");
  });

  it("bounds a long value's height instead of letting the row grow", () => {
    const { container } = renderEvidenceOutput();
    const scrollers = container.querySelectorAll(".max-h-64.overflow-y-auto");

    // Only evidenceQueries is long enough to need its own scroll region.
    expect(scrollers).toHaveLength(1);
    expect(scrollers[0]?.textContent ?? "").toContain("External Source Query Results");
  });

  it("leaves short values inline without a scroll region", () => {
    const { container } = render(
      <StructuredOutputDisplay
        structuredOutput={{ verificationMethod: "source_evidence" }}
      />,
    );

    expect(container.querySelectorAll(".max-h-64")).toHaveLength(0);
    expect(container.textContent ?? "").toContain("source_evidence");
  });
});
