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
  it("scrolls JSON sideways instead of wrapping it", () => {
    render(<RunOutputBlock value='{"a":"x"}' emptyMessage="empty" />);
    const pre = document.querySelector("pre");
    const classes = pre?.className.split(" ") ?? [];
    expect(classes).toContain("whitespace-pre");
    expect(classes).not.toContain("whitespace-pre-wrap");
    expect(pre?.parentElement?.className).toContain("overflow-x-auto");
  });

  it("keeps plain text wrapping", () => {
    render(<RunOutputBlock value="Pages free: 76905." emptyMessage="empty" />);
    expect(document.querySelector("pre")?.className).toContain("whitespace-pre-wrap");
  });
});

describe("FinalOutputPreview", () => {
  it("shows the formatted payload clamped to four lines in monospace", () => {
    const onViewOutput = vi.fn();
    render(
      <FinalOutputPreview
        output={'Fetched 1 finding.\n{"id":"CVE-1"}'}
        emptyMessage="empty"
        onViewOutput={onViewOutput}
      />,
    );

    expect(screen.getByText("Fetched 1 finding.")).toBeTruthy();
    const pre = document.querySelector("pre");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.className).toContain("line-clamp-4");
    expect(pre?.textContent).toBe('{\n  "id": "CVE-1"\n}');

    const toggle = screen.getByRole("button", { name: "common.results.showMore", hidden: true });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("pre")?.className).not.toContain("line-clamp-4");
    expect(toggle.textContent).toBe("common.results.showLess");

    fireEvent.click(screen.getByText("common.results.viewOutput"));
    expect(onViewOutput).toHaveBeenCalledTimes(1);
  });

  it("shows the empty message when there is no output", () => {
    render(<FinalOutputPreview output="" emptyMessage="Nothing yet" onViewOutput={vi.fn()} />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
    expect(screen.queryByText("common.results.viewOutput")).toBeNull();
  });
});
