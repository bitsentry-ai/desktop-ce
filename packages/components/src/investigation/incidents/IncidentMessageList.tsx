import { memo, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { LegendList, type LegendListRef, type MaintainScrollAtEndOptions } from "@legendapp/list/react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { ChatBubble } from "../../chat/ChatBubble";
import type { ChatMessage } from "../../chat/types";

// Same pinning as T3 Code's timeline: follow the newest output on every trigger, without animating.
const MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, footerLayout: false, itemLayout: true, layout: true },
} as const satisfies MaintainScrollAtEndOptions;

// T3 Code's follow re-arm band: streaming growth leaves the view a few pixels short for a frame before the follow
// scroll catches up, so "at the end" allows a small gap.
const FOLLOW_REARM_THRESHOLD_PX = 40;
// Back at the very end, following resumes even when a small move up never left the band.
const END_EPSILON_PX = 1;

const UP_KEYS = ["PageUp", "Home", "ArrowUp"];
const DOWN_KEYS = ["PageDown", "End", "ArrowDown"];

function endGap(state: ReturnType<LegendListRef["getState"]> | undefined): number | undefined {
  if (state === undefined) return undefined;
  return state.contentLength - state.scroll - state.scrollLength;
}

// Navigation keys aimed at the page body scroll the list the reader last pointed at, scrolled or focused.
let activeListNode: HTMLElement | null = null;

/** Whether a wheel or key scrolling `deltaY` at `target` moves the list rather than a scrollable element inside it. */
function isListScrollTarget(target: EventTarget | null, list: HTMLElement, deltaY: number): boolean {
  if (!(target instanceof Element) || !list.contains(target) || deltaY === 0) return false;
  for (let element: Element | null = target; element !== null && element !== list; element = element.parentElement) {
    const style = getComputedStyle(element);
    if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
    const canScroll = deltaY < 0 ? element.scrollTop > 0 : element.scrollTop < element.scrollHeight - element.clientHeight;
    if (canScroll || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false;
  }
  return true;
}

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
 *
 * Following works like T3 Code's live follow: any wheel, touch, keyboard or scrollbar move away from the end stops it,
 * and it resumes when the reader enters the end band again, reaches the very end, or `scrollToEndRef` is called (send,
 * scroll-to-bottom). `onAtEndChange(false)` shows the scroll-to-bottom button: while following, outside the band;
 * otherwise, anywhere short of the very end.
 */
export const IncidentMessageList = memo(function IncidentMessageList({
  messages,
  providerKey,
  listRef,
  headerClassName,
  onAtEndChange,
  scrollToEndRef,
}: {
  messages: ChatMessage[];
  providerKey: string | null;
  listRef: RefObject<LegendListRef | null>;
  /** Sizes the spacer above the first row. */
  headerClassName: string;
  onAtEndChange: (atEnd: boolean) => void;
  /** Set to a function that resumes following and scrolls to the end. */
  scrollToEndRef?: RefObject<((options: { animated: boolean }) => void) | null>;
}) {
  const { t } = useTranslation();
  const [liveFollow, setLiveFollow] = useState(true);
  // Read by scroll events that land before the render that applies `liveFollow`.
  const liveFollowRef = useRef(true);
  const inBandRef = useRef(true);
  // Whether the view left the very end since following stopped. A follow scroll still in flight when the reader
  // stops following lands at the very end, and must not resume it.
  const leftEndRef = useRef(false);

  useImperativeHandle(scrollToEndRef, () => ({ animated }: { animated: boolean }) => {
    inBandRef.current = true;
    liveFollowRef.current = true;
    setLiveFollow(true);
    void listRef.current?.scrollToEnd({ animated });
  }, [listRef]);

  useEffect(() => {
    const node = listRef.current?.getScrollableNode();
    if (node === undefined) return;
    const stopFollowing = () => {
      if (!liveFollowRef.current) return;
      liveFollowRef.current = false;
      leftEndRef.current = false;
      setLiveFollow(false);
    };
    const markActive = () => { activeListNode = node; };
    // Only a gesture that can move the view away from the end stops following: a stop while pinned produces no
    // scroll event, so nothing would resume it.
    const contentScrollsUp = () => node.scrollHeight > node.clientHeight;
    const awayFromEnd = () => (endGap(listRef.current?.getState()) ?? 0) > FOLLOW_REARM_THRESHOLD_PX;
    const onWheel = (event: WheelEvent) => {
      markActive();
      if (event.ctrlKey || !isListScrollTarget(event.target, node, event.deltaY)) return;
      if (event.deltaY < 0 && contentScrollsUp()) stopFollowing();
    };
    // Touch direction isn't known here, so stop once the drag has carried the view out of the end band.
    const onTouchMove = () => { if (awayFromEnd()) stopFollowing(); };
    // Scrollbar drags send no wheel or touch events; they are the pointerdowns that target the list itself.
    const onPointerDown = (event: PointerEvent) => {
      markActive();
      if (event.target === node ? contentScrollsUp() : awayFromEnd()) stopFollowing();
    };
    // Keyboard scrolling bypasses wheel and pointer events. Focus can sit on body after clicking message text.
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const bodyTarget = target === document.body || target === document.documentElement;
      if (!node.contains(target) && !(bodyTarget && activeListNode === node)) return;
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])") !== null) return;
      const up = UP_KEYS.includes(event.key);
      if (!up && !DOWN_KEYS.includes(event.key)) return;
      if (node.contains(target) && target !== node && !isListScrollTarget(target, node, up ? -1 : 1)) return;
      if (up ? contentScrollsUp() : awayFromEnd()) stopFollowing();
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    node.addEventListener("touchstart", markActive, { passive: true });
    node.addEventListener("focusin", markActive);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("touchstart", markActive);
      node.removeEventListener("focusin", markActive);
      document.removeEventListener("keydown", onKeyDown);
      if (activeListNode === node) activeListNode = null;
    };
  }, [listRef]);
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
      // Off while the reader is away from the end; within a whole viewport of the end Legend would otherwise re-pin.
      maintainScrollAtEnd={liveFollow ? MAINTAIN_SCROLL_AT_END : false}
      maintainScrollAtEndThreshold={1}
      maintainVisibleContentPosition
      // Rows hold local UI state, so a reused container remounts its row instead of handing it another message.
      recycleItems={false}
      onScroll={() => {
        const gap = endGap(listRef.current?.getState());
        if (gap === undefined) return;
        const inBand = gap <= FOLLOW_REARM_THRESHOLD_PX;
        const atVeryEnd = gap <= END_EPSILON_PX;
        const enteredBand = inBand && !inBandRef.current;
        inBandRef.current = inBand;
        if (!liveFollowRef.current) {
          if (!atVeryEnd) leftEndRef.current = true;
          if (enteredBand || (atVeryEnd && leftEndRef.current)) {
            liveFollowRef.current = true;
            setLiveFollow(true);
          }
        }
        onAtEndChange(liveFollowRef.current ? inBand : atVeryEnd);
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
