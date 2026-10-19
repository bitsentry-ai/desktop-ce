import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentServicePort } from "../services/contracts";
import type { ComposerQueue } from "./QueuedMessagesPanel";
import type { AgentQueuedMessage, AgentThreadSnapshot, ComposerAttachment } from "./types";

/** The queue as the latest snapshot of a session reports it. */
export interface SessionQueueState {
  messages: AgentQueuedMessage[];
  held: boolean;
  canSteer: boolean;
}

export const EMPTY_SESSION_QUEUE: SessionQueueState = { messages: [], held: false, canSteer: false };

export function sessionQueueFromSnapshot(snapshot: AgentThreadSnapshot): SessionQueueState {
  return {
    messages: snapshot.queuedMessages ?? [],
    held: snapshot.queueHeld === true,
    canSteer: snapshot.canSteer === true,
  };
}

type Draft = { prompt: string; images: ComposerAttachment[] };

/**
 * Queue actions for the composer, and editing a queued message in place of
 * the draft. Like T3 Code, editing moves the message into the composer and
 * keeps the draft aside until the edit is saved or cancelled. If the message
 * runs while it is being edited, the edit becomes the draft when there was no
 * draft, and is dropped otherwise.
 */
export function useComposerQueue(input: {
  agent: Pick<AgentServicePort, "updateQueue">;
  sessionId: string | null;
  queue: SessionQueueState;
  isRunning: boolean;
  prompt: string;
  images: ComposerAttachment[];
  setPrompt: (prompt: string) => void;
  setImages: (images: ComposerAttachment[]) => void;
}): {
  composerQueue: ComposerQueue | undefined;
  editingId: string | null;
  saveEdit: (text: string, images: ComposerAttachment[]) => Promise<void>;
  resume: () => Promise<void>;
} {
  const { agent, sessionId, queue, isRunning, prompt, images, setPrompt, setImages } = input;
  const [editingId, setEditingId] = useState<string | null>(null);
  const stashedDraftRef = useRef<Draft | null>(null);

  const restoreDraft = useCallback(() => {
    const draft = stashedDraftRef.current;
    stashedDraftRef.current = null;
    setEditingId(null);
    setPrompt(draft?.prompt ?? "");
    setImages(draft?.images ?? []);
  }, [setImages, setPrompt]);

  const editedMessageGone = editingId !== null && !queue.messages.some((message) => message.id === editingId);
  useEffect(() => {
    if (!editedMessageGone) return;
    const draft = stashedDraftRef.current;
    if (draft !== null && (draft.prompt.trim().length > 0 || draft.images.length > 0)) {
      restoreDraft();
      return;
    }
    stashedDraftRef.current = null;
    setEditingId(null);
  }, [editedMessageGone, restoreDraft]);

  const update = useCallback(
    async (request: Parameters<NonNullable<AgentServicePort["updateQueue"]>>[0]) => {
      try {
        await agent.updateQueue?.(request);
      } catch (error) {
        // The runtime already ran or removed the message; the next snapshot shows the queue as it is.
        console.warn("Queued message update failed:", error);
      }
    },
    [agent],
  );

  const saveEdit = useCallback(
    async (text: string, editedImages: ComposerAttachment[]) => {
      if (sessionId === null || editingId === null) return;
      await update({ sessionId, action: "edit", messageId: editingId, message: text, attachments: editedImages });
      restoreDraft();
    },
    [editingId, restoreDraft, sessionId, update],
  );

  const resume = useCallback(async () => {
    if (sessionId === null) return;
    await update({ sessionId, action: "resume" });
  }, [sessionId, update]);

  if (sessionId === null || agent.updateQueue === undefined) {
    return { composerQueue: undefined, editingId: null, saveEdit, resume };
  }

  const composerQueue: ComposerQueue = {
    messages: queue.messages,
    held: queue.held,
    canSteer: queue.canSteer,
    isRunning,
    editingId,
    onEdit: (message) => {
      if (editingId === null) stashedDraftRef.current = { prompt, images };
      setEditingId(message.id);
      setPrompt(message.text);
      setImages(message.attachments ?? []);
    },
    onCancelEdit: restoreDraft,
    onRemove: (id) => update({ sessionId, action: "remove", messageId: id }),
    onSteer: (id) => update({ sessionId, action: "steer", messageId: id }),
    onReorder: (id, beforeId) => update({ sessionId, action: "reorder", messageId: id, beforeMessageId: beforeId }),
  };

  return { composerQueue, editingId, saveEdit, resume };
}
