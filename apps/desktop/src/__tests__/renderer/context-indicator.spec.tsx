// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextIndicator } from "@bitsentry-ce/components/chat/ContextIndicator";
import translations from "../../../../../packages/i18n/src/locales/en-US/common.json";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) =>
      (translations[key as keyof typeof translations] ?? key).replace(
        /\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""),
      ),
  }),
}));

afterEach(cleanup);

describe("context indicator", () => {
  it("shows actual usage, including a smaller later value, and labels estimates unavailable", () => {
    const props = { inputTokens: 32_000, outputTokens: 100, contextLimit: 100_000 };
    const { rerender } = render(<ContextIndicator {...props} kind="actual" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("32%");
    rerender(<ContextIndicator {...props} inputTokens={20_000} kind="actual" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("20%");
    rerender(<ContextIndicator {...props} inputTokens={55_000} kind="estimate" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Usage unavailable");
  });

  it("shows the effective budget threshold and removes compaction copy without a budget", async () => {
    const props = { inputTokens: 32_000, outputTokens: 100, contextLimit: 1_050_000 };
    const budget = {
      estimatedTokens: 46_436, estimatedRequestTokens: 32_100, estimatedTotalTokens: 46_436,
      limit: 1_050_000, inputLimit: 1_050_000, outputBudget: 8192,
      toolReserve: 2048, safetyMargin: 4096,
      reserves: { outputBudget: 8192, toolReserve: 2048, safetyMargin: 4096 },
      decision: "sent" as const, reason: "Within budget", costThreshold: 272_000,
      accountRequestCeiling: 100_000, compacted: false, droppedMessageCount: 0,
      droppedToolCallReferences: [],
    };
    const { rerender } = render(<ContextIndicator {...props} sandboxTokenBudget={budget} />);
    fireEvent.pointerEnter(screen.getByRole("button"), { pointerType: "mouse" });
    await waitFor(() => expect(screen.getByText(/estimated request reaches 100,000 tokens/)).toBeDefined());
    rerender(<ContextIndicator {...props} />);
    expect(screen.queryByText(/is compacted when/)).toBeNull();
  });
});
