// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolCard } from "@bitsentry-ce/components/chat/ToolCallCard";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
});

describe("ToolCard progress", () => {
  it("shows the latest progress only while the tool runs", () => {
    const card = {
      toolCallId: "cve-evaluation-1",
      toolName: "evaluate_remediation",
      progress: "Checked 12 of 40 findings, 28 remaining, 1 retrying (14s)",
    };

    const { rerender } = render(<ToolCard card={{ ...card, state: "running" }} />);
    expect(screen.getByText(card.progress)).toBeTruthy();

    rerender(<ToolCard card={{ ...card, state: "done" }} />);
    expect(screen.queryByText(card.progress)).toBeNull();
  });
});
