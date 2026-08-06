// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatBubble, hasWaitingAgentIndicator } from "@bitsentry-ce/components/chat/ChatBubble";
import { Composer } from "@bitsentry-ce/components/chat/Composer";
import type { ChatMessage } from "@bitsentry-ce/components/chat/types";
import { getModelCapability } from "@bitsentry-ce/components/llm/modelCatalog";
import { TooltipProvider } from "@bitsentry-ce/components/ui/tooltip";

let traitTranslations: Record<string, string> = {
  "common.traitsDropdown.reasoning": "Reasoning",
  "common.traitsDropdown.reasoningExtraHigh": "Extra High",
  "common.traitsDropdown.reasoningExtraHighShort": "xHigh",
  "common.traitsDropdown.reasoningHigh": "High",
  "common.traitsDropdown.reasoningLow": "Low",
  "common.traitsDropdown.reasoningMax": "Max",
  "common.traitsDropdown.reasoningMedium": "Medium",
  "common.traitsDropdown.reasoningUltrathink": "Ultrathink",
  "common.traitsDropdown.reasoningUltrathinkShort": "Ultra",
};

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => traitTranslations[key] ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  traitTranslations = {
    "common.traitsDropdown.reasoning": "Reasoning",
    "common.traitsDropdown.reasoningExtraHigh": "Extra High",
    "common.traitsDropdown.reasoningExtraHighShort": "xHigh",
    "common.traitsDropdown.reasoningHigh": "High",
    "common.traitsDropdown.reasoningLow": "Low",
    "common.traitsDropdown.reasoningMax": "Max",
    "common.traitsDropdown.reasoningMedium": "Medium",
    "common.traitsDropdown.reasoningUltrathink": "Ultrathink",
    "common.traitsDropdown.reasoningUltrathinkShort": "Ultra",
  };
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
    expect(hasWaitingAgentIndicator(message)).toBe(true);
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

  it("keeps the pre-snapshot response fallback visible before an agent bubble exists", () => {
    render(
      <Composer
        prompt=""
        onPromptChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        isProcessing
        isBlocked={false}
        isArchived={false}
        composerImages={[]}
        onRemoveImage={vi.fn()}
        onPickImages={vi.fn()}
        onPickFiles={vi.fn()}
        onImageFilesSelected={vi.fn()}
        onPaste={vi.fn()}
        imageInputRef={React.createRef<HTMLInputElement>()}
        fileInputRef={React.createRef<HTMLInputElement>()}
        selectedProviderKey={null}
        selectedModelId=""
        onSelectProvider={vi.fn()}
        onSelectModel={vi.fn()}
        configuredProviderKeys={[]}
        providerConfigs={{}}
        selectedModelCapability={undefined}
        thinkingEnabled={false}
        onThinkingToggle={vi.fn()}
        threadStatus="streaming"
        showThreadWaitingIndicator
      />,
    );

    expect(screen.getByText("common.incidents.aiIsResponding")).toBeTruthy();
  });
});

describe("Composer traits", () => {
  it("renders translated CLI fallback effort labels", () => {
    traitTranslations = {
      "common.traitsDropdown.reasoning": "Penalaran",
      "common.traitsDropdown.reasoningExtraHigh": "Sangat Tinggi",
      "common.traitsDropdown.reasoningExtraHighShort": "Sangat Tinggi",
      "common.traitsDropdown.reasoningHigh": "Tinggi",
      "common.traitsDropdown.reasoningLow": "Rendah",
      "common.traitsDropdown.reasoningMax": "Maksimum",
      "common.traitsDropdown.reasoningMedium": "Sedang",
      "common.traitsDropdown.reasoningUltrathink": "Berpikir Ultra",
      "common.traitsDropdown.reasoningUltrathinkShort": "Ultra",
    };

    render(
      <Composer
        prompt=""
        onPromptChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        isProcessing={false}
        isBlocked={false}
        isArchived={false}
        composerImages={[]}
        onRemoveImage={vi.fn()}
        onPickImages={vi.fn()}
        onPickFiles={vi.fn()}
        onImageFilesSelected={vi.fn()}
        onPaste={vi.fn()}
        imageInputRef={React.createRef<HTMLInputElement>()}
        fileInputRef={React.createRef<HTMLInputElement>()}
        selectedProviderKey="codex"
        selectedModelId="gpt-5.6-terra"
        onSelectProvider={vi.fn()}
        onSelectModel={vi.fn()}
        configuredProviderKeys={['codex']}
        providerConfigs={{}}
        selectedModelCapability={getModelCapability('codex', 'gpt-5.6-terra')}
        thinkingEnabled={false}
        onThinkingToggle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Tinggi" }));

    expect(screen.getByText("Penalaran")).toBeTruthy();
    expect(screen.getByText("Rendah")).toBeTruthy();
    expect(screen.getByText("Sedang")).toBeTruthy();
    expect(screen.getAllByText("Tinggi").length).toBeGreaterThan(1);
    expect(screen.getByText("Sangat Tinggi")).toBeTruthy();
  });

  it("submits the selected fallback CLI effort", () => {
    const onSend = vi.fn();

    render(
      <Composer
        prompt="QA effort fallback"
        onPromptChange={vi.fn()}
        onSend={onSend}
        onCancel={vi.fn()}
        isProcessing={false}
        isBlocked={false}
        isArchived={false}
        composerImages={[]}
        onRemoveImage={vi.fn()}
        onPickImages={vi.fn()}
        onPickFiles={vi.fn()}
        onImageFilesSelected={vi.fn()}
        onPaste={vi.fn()}
        imageInputRef={React.createRef<HTMLInputElement>()}
        fileInputRef={React.createRef<HTMLInputElement>()}
        selectedProviderKey="codex"
        selectedModelId="gpt-5.6-terra"
        onSelectProvider={vi.fn()}
        onSelectModel={vi.fn()}
        configuredProviderKeys={['codex']}
        providerConfigs={{}}
        selectedModelCapability={getModelCapability('codex', 'gpt-5.6-terra')}
        thinkingEnabled={false}
        onThinkingToggle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.sendMessage" }));

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({
      traitValues: expect.objectContaining({ effort: "low" }),
    }));
  });
});
