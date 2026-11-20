// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenizeJson } from "@bitsentry-ce/components/runbook/jsonTokens";
import { HighlightedJson } from "@bitsentry-ce/components/runbook/HighlightedJson";
import { RunOutputBlock } from "@bitsentry-ce/components/runbook/RunOutputBlock";
import { FinalOutputPreview } from "@bitsentry-ce/components/runbook/FinalOutputPreview";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

function kinds(text: string) {
  return tokenizeJson(text).map((token) => [token.kind, token.text]);
}

describe("tokenizeJson", () => {
  it("tells keys from string values and colours scalars", () => {
    const text = JSON.stringify(
      { id: "004", score: -9.1e2, ok: true, missing: null, tags: ["a"] },
      null,
      2,
    );
    const tokens = kinds(text);

    expect(tokens).toContainEqual(["key", '"id"']);
    expect(tokens).toContainEqual(["string", '"004"']);
    expect(tokens).toContainEqual(["number", "-910"]);
    expect(tokens).toContainEqual(["literal", "true"]);
    expect(tokens).toContainEqual(["literal", "null"]);
    expect(tokens).toContainEqual(["string", '"a"']);
    expect(tokens.map(([, value]) => value).join("")).toBe(text);
  });

  it("merges structure and whitespace into single runs", () => {
    expect(kinds('[1, 2]')).toEqual([
      ["punctuation", "["],
      ["number", "1"],
      ["punctuation", ", "],
      ["number", "2"],
      ["punctuation", "]"],
    ]);
  });

  it("keeps escaped quotes and expanded newlines inside one string", () => {
    const text = '{\n  "note": "say \\"hi\\"\nnext: line"\n}';
    expect(kinds(text)).toContainEqual(["string", '"say \\"hi\\"\nnext: line"']);
    expect(kinds(text)).toContainEqual(["key", '"note"']);
  });

  it("tolerates text cut off mid-string by the line cap", () => {
    const tokens = kinds('{\n  "a": "unterminated');
    expect(tokens.at(-1)).toEqual(["string", '"unterminated']);
  });

  it("passes unknown words and symbols through as text", () => {
    expect(kinds("undefined")).toEqual([["text", "undefined"]]);
    expect(kinds("@#")).toEqual([["text", "@#"]]);
  });

  it("returns nothing for empty text", () => {
    expect(tokenizeJson("")).toEqual([]);
  });

  it("gives every token a unique start offset", () => {
    const tokens = tokenizeJson('{"a":[true,false]}');
    const starts = tokens.map((token) => token.start);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts[0]).toBe(0);
  });
});

describe("HighlightedJson", () => {
  it("colours values with the theme status text tokens", () => {
    const { container } = render(
      <pre>
        <HighlightedJson text={'{"a": "x", "b": 1, "c": false}'} />
      </pre>,
    );

    const classOf = (text: string) =>
      Array.from(container.querySelectorAll("span")).find((span) => span.textContent === text)
        ?.className;
    expect(classOf('"a"')).toBe("text-foreground");
    expect(classOf('"x"')).toBe("text-[hsl(var(--success-text))]");
    expect(classOf("1")).toBe("text-[hsl(var(--info-text))]");
    expect(classOf("false")).toBe("text-[hsl(var(--warning-text))]");
    expect(container.textContent).toBe('{"a": "x", "b": 1, "c": false}');
  });
});

describe("RunOutputBlock layout", () => {
  it("shows JSON as readable fields instead of a monospace scroller", () => {
    render(<RunOutputBlock value='{"a":"x"}' emptyMessage="empty" />);
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByText("x")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "common.results.wrapLines" })).toBeNull();
  });

  it("keeps plain text wrapping", () => {
    render(<RunOutputBlock value="Pages free: 76905." emptyMessage="empty" />);
    expect(document.querySelector("pre")?.className).toContain("whitespace-pre-wrap");
  });
});

describe("RunOutputBlock wrap toggle", () => {
  it("starts plain text wrapped and unwraps it into a sideways scroller", () => {
    render(<RunOutputBlock value="Pages free: 76905." emptyMessage="empty" />);
    const toggle = screen.getByRole("button", { name: "common.results.wrapLines" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);
    const classes = document.querySelector("pre")?.className.split(" ") ?? [];
    expect(classes).toContain("whitespace-pre");
    expect(classes).not.toContain("whitespace-pre-wrap");
  });
});

describe("FinalOutputPreview", () => {
  it("shows a short output whole, with no extra action", () => {
    render(
      <FinalOutputPreview
        output={'Fetched 1 finding.\n{"id":"CVE-1"}'}
        emptyMessage="empty"
        onViewOutput={vi.fn()}
      />,
    );

    expect(screen.getByText("Fetched 1 finding.")).toBeTruthy();
    const pre = document.querySelector("pre");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.className).not.toContain("line-clamp-4");
    expect(pre?.textContent).toBe('{\n  "id": "CVE-1"\n}');
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("previews a longer output in eight lines with a View full output button", () => {
    const onViewOutput = vi.fn();
    const output = Array.from({ length: 12 }, (_, index) => `line ${String(index)}`).join("\n");
    render(<FinalOutputPreview output={output} emptyMessage="empty" onViewOutput={onViewOutput} />);

    const pre = document.querySelector("pre");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    expect([...(pre?.children ?? [])].map((line) => line.textContent)).toEqual(
      Array.from({ length: 8 }, (_, index) => `line ${String(index)}`),
    );
    expect(pre?.children[1]?.className).not.toContain("truncate");
    expect(pre?.className).not.toContain("mask-image");
    fireEvent.click(screen.getByRole("button", { name: "common.results.moreLines" }));
    expect(pre?.children).toHaveLength(12);
    expect(screen.getByRole("button", { name: "common.results.showFewerLines" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByText("common.results.showMore")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.results.viewFullOutput" }));
    expect(onViewOutput).toHaveBeenCalledTimes(1);
  });

  it("lists a longer JSON object's top-level fields instead of its braces", () => {
    const value = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`field${String(index)}`, index === 0 ? "ok" : { nested: index }]),
    );
    render(
      <FinalOutputPreview output={JSON.stringify(value)} emptyMessage="empty" onViewOutput={vi.fn()} />,
    );

    const keys = [...document.querySelectorAll("dt")].map((node) => node.textContent);
    expect(keys).toEqual(Array.from({ length: 8 }, (_, index) => `Field${String(index)}`));
    expect(document.querySelector("dd")?.textContent).toBe("ok");
    expect(document.querySelectorAll("dd")[1]?.textContent).toBe("1 field");
    expect(screen.getByText("common.results.moreFields")).toBeTruthy();
    expect(screen.getByRole("button", { name: "common.results.viewFullOutput" })).toBeTruthy();
  });

  it("leads a JSON list result with its outcome and keeps paging fields under Details", () => {
    const value = {
      findings: Array.from({ length: 10 }, (_, index) => ({ id: index })),
      total: 103,
      offset: 0,
      hasMore: true,
      agent: "004",
      retrievedAt: "2026-10-29T07:39:26.836Z",
      severity: "Critical",
      source: "wazuh",
      page: 1,
      window: "24h",
      checkedAt: "2026-11-17",
    };
    render(<FinalOutputPreview output={JSON.stringify(value)} emptyMessage="empty" onViewOutput={vi.fn()} />);

    expect(screen.getByText(/common\.results\.outcomeReturnedOf/)).toBeTruthy();
    const details = document.querySelector("details");
    expect(details?.open).toBe(false);
    const detailKeys = [...(details?.querySelectorAll("dt") ?? [])].map((node) => node.textContent);
    expect(detailKeys).toEqual(["Offset", "Has more", "Page"]);
    expect(screen.getByText("2026-10-29 07:39 UTC")).toBeTruthy();
    cleanup();

    // A sentence before the payload already states the outcome, so no second outcome line is added.
    render(
      <FinalOutputPreview output={`Fetched 10 of 103 findings.\n${JSON.stringify(value)}`} emptyMessage="empty" onViewOutput={vi.fn()} />,
    );
    expect(screen.getByText("Fetched 10 of 103 findings.")).toBeTruthy();
    expect(screen.queryByText(/common\.results\.outcomeReturnedOf/)).toBeNull();
    const mainKeys = [...document.querySelectorAll("dl")][0]?.querySelectorAll("dt");
    expect([...(mainKeys ?? [])].map((node) => node.textContent)).not.toContain("offset");
  });

  it("keeps aligned terminal labels next to their values in a short output shown whole", () => {
    const output = Array.from({ length: 4 }, (_, index) => `Pages free:                          ${String(76905 + index)}.`).join("\n");
    render(<FinalOutputPreview output={output} emptyMessage="empty" onViewOutput={vi.fn()} />);
    expect(document.querySelector("pre")?.textContent?.split("\n")[0]).toBe("Pages free: 76905.");
  });

  it("keeps aligned terminal labels next to their values in the preview", () => {
    const output = Array.from({ length: 14 }, (_, index) => `Pages free:                          ${String(76905 + index)}.`).join("\n");
    render(<FinalOutputPreview output={output} emptyMessage="empty" onViewOutput={vi.fn()} />);
    expect(document.querySelector("pre")?.children[0]?.textContent).toBe("Pages free: 76905.");
  });

  it("treats a few very long lines as a long output", () => {
    render(
      <FinalOutputPreview output={"x".repeat(2000)} emptyMessage="empty" onViewOutput={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "common.results.viewFullOutput" })).toBeTruthy();
  });

  it("shows the empty message when there is no output", () => {
    render(<FinalOutputPreview output="" emptyMessage="Nothing yet" onViewOutput={vi.fn()} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.queryByText("common.results.viewFullOutput")).toBeNull();
  });
});
