// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBubble } from "@bitsentry-ce/components/chat/ChatBubble";
import { Composer, type ComposerProps } from "@bitsentry-ce/components/chat/Composer";
import { ComposerBlockedNotice } from "@bitsentry-ce/components/chat/ComposerBlockedNotice";
import { ResponseStalledBadge } from "@bitsentry-ce/components/chat/ResponseStalledBadge";
import { isTurnStalled, TURN_STALL_AFTER_MS } from "@bitsentry-ce/components/chat/turnTimelineRows";
import { TurnStopContext } from "@bitsentry-ce/components/chat/turnStop";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import type { ModelCatalogEntry } from "@bitsentry-ce/components/llm/modelCatalog";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values === undefined ? key : `${key}(${Object.values(values).join(",")})`,
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type AgentMessage = Extract<ChatMessage, { kind: "agent" }>;

const startedAt = "2026-10-19T10:00:00.000Z";
const startedMs = Date.parse(startedAt);

function runningTurn(): AgentMessage {
  return {
    id: "turn-1",
    kind: "agent",
    iterations: [{ id: "i1", startedAt, text: "", toolCallIds: [], status: "thinking" }],
    activeIterationId: "i1",
    toolCalls: [],
    finalText: null,
    status: "thinking",
  };
}

/** The avatar's activity dot, shown only while a turn works. */
function activityDot(container: HTMLElement) {
  return container.querySelector("span.rounded-full.bg-primary\\/70");
}

function renderAt(nowMs: number, ui: React.ReactElement) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowMs);
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("a running turn's state", () => {
  it("reads as stalled only after a running turn records nothing for the stall window", () => {
    const turn = runningTurn();
    expect(isTurnStalled(turn, startedMs + TURN_STALL_AFTER_MS)).toBe(false);
    expect(isTurnStalled(turn, startedMs + TURN_STALL_AFTER_MS + 1)).toBe(true);
    expect(isTurnStalled({ ...turn, status: "done" }, startedMs + TURN_STALL_AFTER_MS * 10)).toBe(false);
    expect(isTurnStalled({ ...turn, iterations: [] }, startedMs + TURN_STALL_AFTER_MS * 10)).toBe(false);
  });

  it("keeps the activity dot while the turn works", () => {
    const { container } = renderAt(startedMs + 60_000, <ChatBubble msg={runningTurn()} providerKey={null} />);
    expect(screen.getByText(/common.incidents.workingFor/)).toBeTruthy();
    expect(activityDot(container)).not.toBeNull();
  });

  it("shows a stalled turn as a warning with its elapsed time and stop, without activity or spinner", () => {
    const stop = vi.fn();
    const { container } = renderAt(
      startedMs + 24 * 60 * 60_000,
      <TurnStopContext value={stop}>
        <ChatBubble msg={runningTurn()} providerKey={null} />
      </TurnStopContext>,
    );

    const label = screen.getByText("common.incidentDetail.replyStalled");
    const row = label.closest('[role="status"]');
    expect(row?.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
    expect(activityDot(container)).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "common.incidentDetail.stop" }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the header's response badge", () => {
  const user: ChatMessage = { kind: "user", text: "Why is the disk full?" };

  it("shows Response stalled beside the status only while the latest reply is stalled", () => {
    renderAt(startedMs + 24 * 60 * 60_000, <ResponseStalledBadge messages={[user, runningTurn()]} />);
    expect(screen.getByText("common.incidentDetail.responseStalled")).toBeTruthy();
  });

  it("stays hidden for a reply still inside the stall window, a finished reply, or no reply", () => {
    const { rerender } = renderAt(startedMs + 60_000, <ResponseStalledBadge messages={[runningTurn()]} />);
    expect(screen.queryByText("common.incidentDetail.responseStalled")).toBeNull();

    vi.setSystemTime(startedMs + 24 * 60 * 60_000);
    rerender(<TooltipProvider><ResponseStalledBadge messages={[{ ...runningTurn(), status: "done" }]} /></TooltipProvider>);
    expect(screen.queryByText("common.incidentDetail.responseStalled")).toBeNull();

    rerender(<TooltipProvider><ResponseStalledBadge messages={[user]} /></TooltipProvider>);
    expect(screen.queryByText("common.incidentDetail.responseStalled")).toBeNull();
  });
});

describe("the answer action row", () => {
  it("puts the host's actions on the copy row of a finished reply", () => {
    const reply: AgentMessage = { ...runningTurn(), iterations: [], activeIterationId: null, finalText: "The disk is full.", status: "done" };
    render(
      <TooltipProvider>
        <ChatBubble msg={reply} actions={<button type="button">Rate</button>} />
      </TooltipProvider>,
    );
    const copy = screen.getByRole("button", { name: "common.markdown.copyResponseMarkdown" });
    expect(copy.parentElement).toBe(screen.getByRole("button", { name: "Rate" }).parentElement);
  });
});

const model: ModelCatalogEntry = {
  id: "model-1",
  displayName: "Model 1",
  supportsImageInput: false,
  supportsAudioInput: false,
  supportsVideoInput: false,
  supportsPdfInput: false,
  supportsThinking: false,
  thinkingMode: "unsupported",
  reasoningOptions: [],
};

function blockedComposer(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    prompt: "",
    onPromptChange: vi.fn(),
    onSend: vi.fn(),
    onCancel: vi.fn(),
    isProcessing: false,
    isBlocked: true,
    blockedNotice: (
      <ComposerBlockedNotice title="No chat model" description="Add an API key in Settings." actionLabel="Open Settings" onAction={vi.fn()} />
    ),
    isArchived: false,
    composerImages: [],
    onRemoveImage: vi.fn(),
    onPickImages: vi.fn(),
    onPickFiles: vi.fn(),
    onImageFilesSelected: vi.fn(),
    onPaste: vi.fn(),
    imageInputRef: React.createRef<HTMLInputElement>(),
    fileInputRef: React.createRef<HTMLInputElement>(),
    selectedProviderKey: null,
    selectedModelId: "",
    onSelectProvider: vi.fn(),
    onSelectModel: vi.fn(),
    configuredProviderKeys: [],
    providerConfigs: {},
    selectedModelCapability: model,
    thinkingEnabled: false,
    onThinkingToggle: vi.fn(),
    threadStatus: "ready",
    tokenUsage: { kind: "actual", inputTokens: 4_000, outputTokens: 1_000, contextLimit: 100_000 },
    ...overrides,
  };
}

describe("the composer while chat is unavailable", () => {
  it("states the reason on one line and shows send as unavailable, without the context meter", () => {
    const onAction = vi.fn();
    render(
      <TooltipProvider>
        <Composer
          {...blockedComposer({
            blockedNotice: (
              <ComposerBlockedNotice title="No chat model" description="Add an API key in Settings." actionLabel="Open Settings" onAction={onAction} />
            ),
          })}
        />
      </TooltipProvider>,
    );

    const notice = screen.getByRole("status");
    expect(notice.querySelectorAll("p")).toHaveLength(1);
    // The explanation stays available to screen readers and on hover.
    expect(screen.getByText("Add an API key in Settings.").className).toContain("sr-only");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(onAction).toHaveBeenCalledTimes(1);

    const send = screen.getByRole("button", { name: "common.incidents.sendMessage" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("aria-disabled")).toBe("true");
    expect(send.getAttribute("aria-description")).toBe("common.incidentDetail.sendNeedsProvider");
    expect(screen.queryByRole("button", { name: /common.contextIndicator.contextWindowAriaLabel/ })).toBeNull();
  });

  it("shows the context meter with its percentage once chat is available", () => {
    render(
      <TooltipProvider>
        <Composer {...blockedComposer({ isBlocked: false, blockedNotice: undefined, prompt: "Check the disk", selectedProviderKey: "openai", selectedModelId: "model-1" })} />
      </TooltipProvider>,
    );

    const meter = screen.getByRole("button", { name: /common.contextIndicator.contextWindowAriaLabel/ });
    expect(meter.textContent).toBe("5%");
    const send = screen.getByRole("button", { name: "common.incidents.sendMessage" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(send.getAttribute("aria-description")).toBeNull();
  });
});
