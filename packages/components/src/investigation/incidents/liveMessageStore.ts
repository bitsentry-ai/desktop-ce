import { create } from "zustand";
import type { ChatMessage } from "../../chat/types";

/** Per incident: the page's copy of its streaming message, and the newer text-only version its row shows. */
const useLiveMessageStore = create<Record<string, { base: ChatMessage; message: ChatMessage }>>(() => ({}));

/** The row's message, with text streamed since the page last received it. */
export function useLiveMessage(message: ChatMessage): ChatMessage {
  return useLiveMessageStore((live) => Object.values(live).find((entry) => entry.base === message)?.message) ?? message;
}

/** What the page and the rail read from a message; streamed text and tool output stay with the row. */
function messageStructure(message: ChatMessage): string {
  if (message.kind === "user") return JSON.stringify(message);
  return JSON.stringify([
    message.status, message.activity, message.activeIterationId, message.errorMsg,
    message.iterations.map((iteration) => [iteration.id, iteration.status, iteration.toolCallIds.length]),
    message.toolCalls.map((call) => [call.toolCallId, call.state]),
  ]);
}

/**
 * Shows `next` in the row of `base`, the page's copy of the same message, when only its text changed, so the page
 * and list skip the update. Returns false for a structural change, which the page applies instead.
 */
export function publishLiveText(incidentId: string, base: ChatMessage, next: ChatMessage): boolean {
  if (base.id !== next.id || messageStructure(base) !== messageStructure(next)) return false;
  useLiveMessageStore.setState({ [incidentId]: { base, message: next } });
  return true;
}

/** Drops the incident's streamed copy (every incident's when omitted) once the page holds newer messages or unmounts. */
export function clearLiveText(incidentId?: string): void {
  const live = useLiveMessageStore.getState();
  if (incidentId !== undefined && !(incidentId in live)) return;
  const rest = incidentId === undefined ? {} : Object.fromEntries(Object.entries(live).filter(([id]) => id !== incidentId));
  useLiveMessageStore.setState(rest, true);
}
