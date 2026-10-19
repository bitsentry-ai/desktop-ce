import { memo, type RefObject } from "react";
import { LegendList, type LegendListRef, type MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { ChatBubble } from "../../chat/ChatBubble";
import type { ChatMessage } from "../../chat/types";

// Same pinning as T3 Code's timeline: follow the newest output on every trigger, without animating.
const MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;

// The placeholder rows shown for an expired session have no id, so they fall back to the index.
function keyExtractor(msg: ChatMessage, index: number) {
  return msg.id ?? String(index);
}

function getItemType(msg: ChatMessage) {
  return msg.kind;
}

/**
 * The incident's chat rows, virtualized: only the visible rows and a small buffer are mounted. The list is the scroll
 * container, stays pinned to the end while a reply streams, and keeps its place when the reader scrolls up.
 * Streaming replaces only the changed message, so other rows keep their props and skip rendering.
 */
export const IncidentMessageList = memo(function IncidentMessageList({
  messages,
  providerKey,
  listRef,
  headerClassName,
  onAtEndChange,
}: {
  messages: ChatMessage[];
  providerKey: string | null;
  listRef: RefObject<LegendListRef | null>;
  /** Sizes the spacer above the first row. */
  headerClassName: string;
  onAtEndChange: (atEnd: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <LegendList<ChatMessage>
      ref={listRef}
      data={messages}
      extraData={providerKey}
      keyExtractor={keyExtractor}
      getItemType={getItemType}
      renderItem={({ item }) => (
        <div className="space-y-3 pb-5" data-message-id={item.id}>
          <ChatBubble msg={item} providerKey={providerKey} />
        </div>
      )}
      estimatedItemSize={90}
      initialScrollAtEnd
      maintainScrollAtEnd={MAINTAIN_SCROLL_AT_END}
      // A tenth of the viewport, the library default. T3 Code uses a whole viewport because it also stops following on
      // wheel input; without that, a reader one screen up would be pulled back to the end on every streamed update.
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition
      // Rows hold local UI state, so a reused container remounts its row instead of handing it another message.
      recycleItems={false}
      onScroll={() => {
        const state = listRef.current?.getState();
        if (state !== undefined) onAtEndChange(state.isAtEnd);
      }}
      // Legend sets overflow-x inline, so a class can't hide it; without this a long token scrolls the whole chat sideways.
      showsHorizontalScrollIndicator={false}
      // The list is the scroll container, so it takes focus for keyboard scrolling.
      tabIndex={0}
      aria-label={t("common.incidents.messageList")}
      className="page-enter absolute inset-0"
      contentContainerClassName="px-6"
      ListHeaderComponent={<div className={headerClassName} />}
      ListFooterComponent={<div className="h-1" />}
    />
  );
});
