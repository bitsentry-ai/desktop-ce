// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

describe("ChatBubble waiting state", () => {
  it("renders only Working for while thinking, without an Asking model chip", () => {
    const message: Extract<ChatMessage, { kind: "agent" }> = {
      kind: "agent",
      activity: "asking_model",
      iterations: [
        {
          id: "iteration-1",
          startedAt: new Date().toISOString(),
          text: "",
          streamDeltas: [],
          toolCallIds: [],
          status: "thinking",
        },
      ],
      activeIterationId: "iteration-1",
      toolCalls: [],
      finalText: null,
      status: "thinking",
    };

    render(
      <TooltipProvider>
        <ChatBubble msg={message} providerKey="openai" />
      </TooltipProvider>,
    );

    expect(screen.getAllByText(/common\.incidents\.workingFor/)).toHaveLength(1);
    expect(screen.queryByText("Asking model")).toBeNull();
  });

  it("keeps Working for visible after thinking_start is skipped", () => {
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const completedAt = new Date().toISOString();
    const message: Extract<ChatMessage, { kind: "agent" }> = {
      kind: "agent",
      activity: "running_runbook",
      iterations: [
        {
          id: "iteration-1",
          startedAt,
          completedAt,
          text: "Partial response before the next tool call.",
          streamDeltas: [],
          toolCallIds: ["tool-1"],
          status: "streaming",
        },
      ],
      activeIterationId: "iteration-1",
      toolCalls: [
        {
          toolCallId: "tool-1",
          toolName: "execute_runbook",
          state: "done",
          output: "Runbook completed.",
        },
      ],
      finalText: null,
      status: "streaming",
    };

    render(
      <TooltipProvider>
        <ChatBubble msg={message} providerKey="openai" />
      </TooltipProvider>,
    );

    expect(screen.getAllByText(/common\.incidents\.workingFor/)).toHaveLength(1);
    expect(screen.getByText("Partial response before the next tool call.")).toBeTruthy();
  });
});
