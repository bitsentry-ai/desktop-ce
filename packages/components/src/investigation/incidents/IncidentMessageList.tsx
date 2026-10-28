import { memo } from "react";
import { ChatBubble } from "../../chat/ChatBubble";
import type { ChatMessage } from "../../chat/types";

/** The incident's chat rows. Streaming replaces only the changed message, so other rows keep their props and skip rendering. */
export const IncidentMessageList = memo(function IncidentMessageList({
  messages,
  providerKey,
}: {
  messages: ChatMessage[];
  providerKey: string | null;
}) {
  return messages.map((msg, index) => (
    // The placeholder rows shown for an expired session have no id, so they fall back to the index.
    <div key={msg.id ?? index} className="space-y-3">
      <ChatBubble msg={msg} providerKey={providerKey} />
    </div>
  ));
});
