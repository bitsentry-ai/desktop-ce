// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "@bitsentry-ce/components/chat/Composer";
import type { ComposerQueue } from "@bitsentry-ce/components/chat/QueuedMessagesPanel";

vi.mock("@bitsentry-ce/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  cleanup();
});

function queueWith(overrides: Partial<ComposerQueue> = {}): ComposerQueue {
  return {
    messages: [
      { id: "q-1", text: "Then check memory.", queuedAt: "2026-10-19T00:00:00.000Z" },
      { id: "q-2", text: "Then check load.", queuedAt: "2026-10-19T00:00:01.000Z" },
    ],
    held: false,
    canSteer: true,
    isRunning: true,
    editingId: null,
    onEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onRemove: vi.fn(async () => {}),
    onSteer: vi.fn(async () => {}),
    onReorder: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderComposer(props: Partial<ComposerProps>) {
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <Composer
      prompt=""
      onPromptChange={vi.fn()}
      onSend={onSend}
      onCancel={onCancel}
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
      selectedProviderKey="anthropic"
      selectedModelId="claude-test"
      onSelectProvider={vi.fn()}
      onSelectModel={vi.fn()}
      configuredProviderKeys={["anthropic"]}
      providerConfigs={{}}
      selectedModelCapability={undefined}
      thinkingEnabled={false}
      onThinkingToggle={vi.fn()}
      threadStatus="streaming"
      {...props}
    />,
  );
  return { onSend, onCancel, textarea: screen.getByRole("textbox") };
}

describe("Composer while the agent runs", () => {
  it("keeps the text box open and offers stop until something is typed", () => {
    const { onCancel, textarea } = renderComposer({});

    expect((textarea as HTMLTextAreaElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "common.incidents.composer.stopGeneration" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("queues on Enter and steers on Ctrl/⌘+Enter", () => {
    const { onSend, textarea } = renderComposer({ prompt: "Focus on nginx.", queue: queueWith() });

    expect(screen.getByRole("button", { name: "common.incidents.composer.queueMessage" })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

    expect(onSend.mock.calls.map(([options]) => (options as { delivery?: string }).delivery)).toEqual(["queue", "steer"]);
  });

  it("queues on Ctrl/⌘+Enter too when the turn cannot take a steer", () => {
    const { onSend, textarea } = renderComposer({ prompt: "Only the last hour.", queue: queueWith({ canSteer: false }) });

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ delivery: "queue" }));
    const steerButtons = screen.getAllByRole("button", { name: /common.incidents.queue.steer$/ }) as HTMLButtonElement[];
    expect(steerButtons.every((button) => button.disabled)).toBe(true);
  });

  it("edits the last queued message with Alt+↑ and removes a queued message", () => {
    const queue = queueWith();
    const { textarea } = renderComposer({ queue });

    fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
    expect(queue.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "q-2" }));

    fireEvent.click(screen.getAllByRole("button", { name: "common.incidents.queue.remove" })[0]);
    expect(queue.onRemove).toHaveBeenCalledWith("q-1");
  });

  it("saves an edited queued message instead of sending a new one", () => {
    const { onSend, textarea } = renderComposer({ prompt: "Then check swap.", queue: queueWith({ editingId: "q-2" }) });

    expect(screen.getByRole("button", { name: "common.incidents.composer.updateQueuedMessage" })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ delivery: undefined }));
  });
});

describe("Composer after a stop", () => {
  it("offers to resume a held queue", () => {
    const onResumeQueue = vi.fn();
    renderComposer({
      isProcessing: false,
      threadStatus: "cancelled",
      queue: queueWith({ held: true, isRunning: false }),
      onResumeQueue,
    });

    fireEvent.click(screen.getByRole("button", { name: "common.incidents.composer.resumeThread" }));
    expect(onResumeQueue).toHaveBeenCalledTimes(1);
  });
});
