// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunbookCollapsedActionCard } from "@bitsentry-ce/components/desktop/runbook/RunbookCollapsedActionCard";

function renderCard(
  overrides: Partial<
    React.ComponentProps<typeof RunbookCollapsedActionCard>
  > = {},
) {
  const props: React.ComponentProps<typeof RunbookCollapsedActionCard> = {
    index: 1,
    collapsedActionTitle: "Top processes by CPU",
    actionType: "shell",
    summary: "ps -Ao pid,pcpu,comm -r | head -12",
    isDragging: false,
    isDragSource: false,
    isDropTarget: false,
    onClick: vi.fn(),
    onDelete: vi.fn(),
    deleteTitle: "Delete action",
    renderTypeBadge: () => <span>Shell</span>,
    ...overrides,
  };
  const view = render(<RunbookCollapsedActionCard {...props} />);
  return { props, container: view.container };
}

afterEach(() => {
  cleanup();
});

describe("RunbookCollapsedActionCard", () => {
  it("always shows the drag handle at reduced emphasis, full on hover or focus", () => {
    const { container } = renderCard();

    const svg = container.querySelector("svg.lucide-grip-vertical");
    expect(svg).not.toBeNull();
    const grip = svg?.parentElement;
    expect(grip?.className).toContain("opacity-60");
    expect(grip?.className).not.toContain("opacity-0");
    expect(grip?.className).toContain("group-hover:opacity-100");
    expect(grip?.className).toContain("group-focus-within:opacity-100");
    expect(grip?.className).toContain("cursor-grab");
  });

  it("shows a tabular step number and a 14px medium-weight title", () => {
    renderCard();

    const number = screen.getByText("2");
    expect(number.className).toContain("tabular-nums");

    const title = screen.getByText("Top processes by CPU");
    expect(title.className).toContain("text-sm");
    expect(title.className).toContain("leading-5");
    expect(title.className).toContain("font-medium");
  });

  it("deletes without opening the card", () => {
    const { props } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Delete action" }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onClick).not.toHaveBeenCalled();
  });
});
