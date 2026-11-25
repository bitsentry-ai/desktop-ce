/**
 * Reading quotes out of rendered agent text, and finding them again, adapted
 * from T3 Code's assistant text selection and citation source
 * (https://github.com/pingdotgg/t3code, MIT). A source's text is its text nodes
 * in order, with a line break between blocks, so a quote across paragraphs
 * keeps them apart.
 */

import { buildCitation, findCitationRange, type AssistantCitation } from "./citations";
import { openDisclosure } from "./disclosureStore";
import { deriveTurnTimeline, finalTextSourceId, iterationTextSourceId } from "./turnTimelineRows";
import { isSelectionRectVisible, type SelectionRect } from "./selectionActions";
import type { ChatMessage } from "./types";

export const CITATION_SOURCE_ATTRIBUTE = "data-citation-source";

const BLOCK_SELECTOR = "p, li, pre, div, h1, h2, h3, h4, h5, h6, blockquote, tr, table, ul, ol";

interface SourceText {
  text: string;
  nodes: Array<{ node: Text; start: number }>;
}

function blockOf(node: Node, source: Element): Element {
  const block = node.parentElement?.closest(BLOCK_SELECTOR);
  return block !== null && block !== undefined && source.contains(block) ? block : source;
}

function readSourceText(source: Element): SourceText {
  const walker = source.ownerDocument.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const nodes: SourceText["nodes"] = [];
  let text = "";
  let previousBlock: Element | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text;
    const block = blockOf(textNode, source);
    if (previousBlock !== null && block !== previousBlock && text.length > 0 && !text.endsWith("\n")) text += "\n";
    previousBlock = block;
    nodes.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  return { text, nodes };
}

const isAfter = (reference: Node, node: Node) =>
  (reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !reference.contains(node);
const isBefore = (reference: Node, node: Node) =>
  (reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING) !== 0 && !node.contains(reference);
const isWithin = (reference: Node, node: Node) => reference === node || reference.contains(node);

/** A selection boundary as a place in a text node: a boundary between elements moves to the nearest text. */
function toTextPoint(textNodes: Text[], container: Node, offset: number, edge: "start" | "end"): { node: Text; offset: number } | null {
  if (container.nodeType === Node.TEXT_NODE) return { node: container as Text, offset };
  if (edge === "start") {
    const next = container.childNodes.item(offset) as Node | null;
    const node = textNodes.find((text) => next === null ? isAfter(container, text) : isWithin(next, text) || isAfter(next, text));
    return node === undefined ? null : { node, offset: 0 };
  }
  const previous = offset > 0 ? container.childNodes.item(offset - 1) as Node | null : null;
  const candidates = textNodes.filter((text) => previous === null ? isBefore(container, text) : isWithin(previous, text) || isBefore(previous, text));
  const node = candidates[candidates.length - 1] as Text | undefined;
  return node === undefined ? null : { node, offset: node.length };
}

function textOffset(source: SourceText, point: { node: Text; offset: number } | null): number | null {
  if (point === null) return null;
  const entry = source.nodes.find((candidate) => candidate.node === point.node);
  return entry === undefined ? null : entry.start + point.offset;
}

/** Where a citation came from on screen: its source text, the quoted range in it, and the scroll container. */
export interface CitationSourceAnchor {
  source: Element;
  range: Range;
  viewport: HTMLElement;
}

/** The citation for the current selection, when it sits inside one agent text source in the viewport. */
export function captureSelectionCitation(
  viewport: HTMLElement,
  threadId: string,
): { citation: AssistantCitation; anchor: CitationSourceAnchor } | null {
  const selection = viewport.ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const source = startElement?.closest(`[${CITATION_SOURCE_ATTRIBUTE}]`) ?? null;
  if (source === null || !viewport.contains(source) || !source.contains(range.endContainer)) return null;

  const sourceText = readSourceText(source);
  const textNodes = sourceText.nodes.map((entry) => entry.node);
  const start = textOffset(sourceText, toTextPoint(textNodes, range.startContainer, range.startOffset, "start"));
  const end = textOffset(sourceText, toTextPoint(textNodes, range.endContainer, range.endOffset, "end"));
  if (start === null || end === null || end <= start) return null;

  const citation = buildCitation({
    threadId,
    sourceId: source.getAttribute(CITATION_SOURCE_ATTRIBUTE) ?? "",
    sourceText: sourceText.text,
    selectionStart: start,
    selectionEnd: end,
  });
  if (citation === null || citation.sourceId.length === 0) return null;
  // The selection's own range changes as the engineer selects again; the anchor keeps its own copy.
  return { citation, anchor: { source, range: range.cloneRange(), viewport } };
}

/** The part of a text node inside a range, or null when that part is blank or cannot be selected. */
function selectedPart(node: Node, range: Range): Range | null {
  if (!range.intersectsNode(node)) return null;
  if (node.parentElement !== null && getComputedStyle(node.parentElement).userSelect === "none") return null;
  const part = node.ownerDocument?.createRange();
  if (part === undefined) return null;
  part.selectNodeContents(node);
  if (node === range.startContainer) part.setStart(node, range.startOffset);
  if (node === range.endContainer) part.setEnd(node, range.endOffset);
  return part.toString().trim().length === 0 ? null : part;
}

const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "scroll", "auto"]);

/** The boxes that clip a node: the viewport, and each scrolling or clipping ancestor up to it. */
function clipsOf(node: Node, viewport: HTMLElement, viewportRect: SelectionRect): SelectionRect[] {
  const clips: SelectionRect[] = [viewportRect];
  for (let element = node.parentElement; element !== null && element !== viewport; element = element.parentElement) {
    const style = getComputedStyle(element);
    const clipX = CLIPPING_OVERFLOW.has(style.overflowX);
    const clipY = CLIPPING_OVERFLOW.has(style.overflowY);
    if (!clipX && !clipY) continue;
    const bounds = element.getBoundingClientRect();
    const left = bounds.left + element.clientLeft;
    const top = bounds.top + element.clientTop;
    clips.push({
      left: clipX ? left : -Infinity,
      right: clipX ? left + element.clientWidth : Infinity,
      top: clipY ? top : -Infinity,
      bottom: clipY ? top + element.clientHeight : Infinity,
    });
  }
  return clips;
}

/**
 * Whether some selected text is on screen: not scrolled out of the viewport, and not hidden in the overflow of a code
 * block or table it sits in. A selection can cross blocks with different clipping ancestors, so each text node counts.
 */
export function isSelectionRectVisibleInViewport({ range, viewport }: CitationSourceAnchor): boolean {
  const viewportRect = viewport.getBoundingClientRect();
  if (!isSelectionRectVisible(range.getBoundingClientRect(), [viewportRect])) return false;
  const common = range.commonAncestorContainer;
  const walker = viewport.ownerDocument.createTreeWalker(common, NodeFilter.SHOW_TEXT);
  for (let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode(); node !== null; node = walker.nextNode()) {
    const part = selectedPart(node, range);
    if (part === null) continue;
    const clips = clipsOf(node, viewport, viewportRect);
    if (Array.from(part.getClientRects()).some((line) => isSelectionRectVisible(line, clips))) return true;
  }
  return false;
}

/** Maps each character of the whitespace-normalized text back to its place in the raw text. */
function normalizedIndexMap(raw: string): number[] {
  const map: number[] = [];
  let inWhitespace = false;
  for (let index = 0; index < raw.length; index++) {
    const isWhitespace = /\s/.test(raw[index]);
    if (isWhitespace && inWhitespace) continue;
    inWhitespace = isWhitespace;
    map.push(index);
  }
  map.push(raw.length);
  return map;
}

/** The quoted text's range in its source, or null when the text changed so the quote cannot be found. */
export function resolveCitationRange(source: Element, citation: AssistantCitation): Range | null {
  const sourceText = readSourceText(source);
  const found = findCitationRange(sourceText.text, citation);
  if (found === null) return null;
  const map = normalizedIndexMap(sourceText.text);
  const rawStart = map[found.start];
  const rawEnd = map[Math.min(found.end, map.length - 1)];
  const locate = (offset: number, edge: "start" | "end") => {
    for (let index = sourceText.nodes.length - 1; index >= 0; index--) {
      const entry = sourceText.nodes[index];
      // A quote's end at a node boundary belongs to the node before it, so the range does not take in the next node.
      if (edge === "end" ? entry.start < offset : entry.start <= offset) {
        return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.length) };
      }
    }
    return null;
  };
  const startPoint = locate(rawStart, "start");
  const endPoint = locate(rawEnd, "end");
  if (startPoint === null || endPoint === null) return null;
  const range = source.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

/**
 * The rendered source of a citation under root, if it is mounted. An answer can be shown under another id than the one
 * it was cited under (the Dashboard streams each step under its own id, then reloads the turn as one answer), so a
 * mounted answer that still holds the quote with its surrounding text counts too, the latest first.
 */
export function findCitationSource(root: ParentNode, citation: AssistantCitation): HTMLElement | null {
  const sources = [...root.querySelectorAll<HTMLElement>(`[${CITATION_SOURCE_ATTRIBUTE}]`)];
  const exact = sources.find((element) => element.getAttribute(CITATION_SOURCE_ATTRIBUTE) === citation.sourceId);
  if (exact !== undefined) return exact;
  return sources.reverse().find((element) => resolveCitationRange(element, citation) !== null) ?? null;
}

type HighlightRegistry = Map<string, unknown>;
type HighlightInstance = { add: (range: Range) => void; delete: (range: Range) => boolean; size: number };
type HighlightConstructor = new (...ranges: Range[]) => HighlightInstance;

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (globalThis.CSS as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  return registry === undefined || Highlight === undefined ? null : { registry, Highlight };
}

const COMMENT_HIGHLIGHT_NAME = "bitsentry-citation-comment";

/**
 * Marks the quoted text while its comment is being written, and keeps the range on the quote as the answer re-renders.
 * Calls onUnavailable once the source leaves the screen or the quote can no longer be found.
 */
export function observeCitationCommentSource({
  anchor,
  citation,
  onUnavailable,
}: {
  anchor: CitationSourceAnchor;
  citation: AssistantCitation;
  onUnavailable: () => void;
}): () => void {
  const { source, range, viewport } = anchor;
  const api = highlightApi();
  let highlight: HighlightInstance | null = null;
  let stopped = false;
  const observer = new MutationObserver((records) => {
    if (stopped) return;
    validate(records.some((record) => source.contains(record.target)));
  });
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (highlight === null || api === null) return;
    highlight.delete(range);
    if (highlight.size === 0 && api.registry.get(COMMENT_HIGHLIGHT_NAME) === highlight) api.registry.delete(COMMENT_HIGHLIGHT_NAME);
  };
  const validate = (sourceChanged: boolean): boolean => {
    if (!source.isConnected || !viewport.contains(source)) {
      dispose();
      onUnavailable();
      return false;
    }
    if (sourceChanged || range.collapsed || !source.contains(range.startContainer) || !source.contains(range.endContainer)) {
      const repaired = resolveCitationRange(source, citation);
      if (repaired === null) {
        dispose();
        onUnavailable();
        return false;
      }
      range.setStart(repaired.startContainer, repaired.startOffset);
      range.setEnd(repaired.endContainer, repaired.endOffset);
    }
    return true;
  };

  if (!validate(false)) return dispose;
  if (api !== null) {
    const existing = api.registry.get(COMMENT_HIGHLIGHT_NAME) as HighlightInstance | undefined;
    highlight = existing ?? new api.Highlight();
    highlight.add(range);
    if (existing === undefined) api.registry.set(COMMENT_HIGHLIGHT_NAME, highlight);
  }
  observer.observe(viewport, { childList: true, subtree: true, characterData: true });
  return dispose;
}

// T3 Code's citation pulse: two quick pulses, a hold, then a fade.
const PULSE_DURATION_MS = 650;
const HIGHLIGHT_HOLD_MS = 1575;
const HIGHLIGHT_FADE_MS = 450;
const HIGHLIGHT_TOTAL_MS = 1.5 * PULSE_DURATION_MS + HIGHLIGHT_HOLD_MS + HIGHLIGHT_FADE_MS;
const HIGHLIGHT_PEAK = 0.45;
const HIGHLIGHT_OPACITY = "--bitsentry-citation-highlight-opacity";
const HIGHLIGHT_NAME = "bitsentry-citation";

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Pulses the quote in its source, then fades it. Returns a stop that clears it early. */
function pulseCitation(source: HTMLElement, citation: AssistantCitation, initialRange: Range, onDone: () => void): () => void {
  const api = highlightApi();
  let stopped = false;
  let selected: Range | null = null;
  let range = initialRange;
  let highlight: HighlightInstance | null = null;
  let disconnect: (() => void) | null = null;
  if (api !== null) {
    highlight = new api.Highlight(range);
    api.registry.set(HIGHLIGHT_NAME, highlight);
    // A streaming answer rewrites its text nodes, which can shift or collapse the range; find the quote again.
    const observer = new MutationObserver(() => {
      if (stopped || highlight === null) return;
      const repaired = resolveCitationRange(source, citation);
      if (repaired === null) return;
      highlight.delete(range);
      range = repaired;
      highlight.add(range);
    });
    observer.observe(source, { childList: true, characterData: true, subtree: true });
    disconnect = () => { observer.disconnect(); };
  } else {
    // Without the highlight API the quote is selected instead, as T3 Code does.
    const selection = source.ownerDocument.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    selected = range;
  }
  const at = (milliseconds: number) => milliseconds / HIGHLIGHT_TOTAL_MS;
  const holdEnd = at(HIGHLIGHT_TOTAL_MS - HIGHLIGHT_FADE_MS);
  const keyframes: Keyframe[] = prefersReducedMotion()
    ? [
        { offset: 0, [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: holdEnd, [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: 1, [HIGHLIGHT_OPACITY]: 0 },
      ]
    : [
        { offset: 0, [HIGHLIGHT_OPACITY]: 0 },
        { offset: at(PULSE_DURATION_MS * 0.5), [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: at(PULSE_DURATION_MS), [HIGHLIGHT_OPACITY]: 0 },
        { offset: at(PULSE_DURATION_MS * 1.5), [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: holdEnd, [HIGHLIGHT_OPACITY]: HIGHLIGHT_PEAK },
        { offset: 1, [HIGHLIGHT_OPACITY]: 0 },
      ];
  const animation = typeof source.animate === "function"
    ? source.animate(keyframes, { duration: HIGHLIGHT_TOTAL_MS, easing: "ease-in-out" })
    : null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    disconnect?.();
    animation?.cancel();
    if (api !== null && highlight !== null && api.registry.get(HIGHLIGHT_NAME) === highlight) api.registry.delete(HIGHLIGHT_NAME);
    if (selected !== null) {
      const selection = source.ownerDocument.getSelection();
      if (selection?.rangeCount === 1 && selection.getRangeAt(0) === selected) selection.removeAllRanges();
    }
  };
  const timer = setTimeout(() => {
    stop();
    onDone();
  }, HIGHLIGHT_TOTAL_MS);
  return stop;
}

export type CitationRevealOutcome = "highlighted" | "changed" | "missing";

export interface CitationRevealList {
  /** The element that scrolls the messages. */
  getScrollableNode: () => unknown;
  scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number }) => Promise<void>;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => Promise<void>;
}

// Frames to wait for a citation's source row to mount after scrolling to it.
const REVEAL_MOUNT_FRAMES = 60;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** The message that holds a citation's source text, and whether that text is folded behind "Worked for". */
function findSourceMessage(messages: readonly ChatMessage[], sourceId: string): { index: number; folded: boolean; messageId?: string } | null {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.kind !== "agent") continue;
    const ownsSource = message.iterations.some((iteration) => iterationTextSourceId(iteration.id) === sourceId)
      || (message.id !== undefined && finalTextSourceId(message.id) === sourceId);
    if (!ownsSource) continue;
    const folded = deriveTurnTimeline(message).foldedRows.some((row) => row.key === sourceId);
    return { index, folded, ...(message.id === undefined ? {} : { messageId: message.id }) };
  }
  return null;
}

let activeReveal: (() => void) | null = null;

/**
 * Goes to a cited quote the way T3 Code does: the list scrolls the quote to a third of the way down (at most 120px from
 * the top), focuses its answer for screen readers, and pulses the quote. A source outside the render window is not
 * mounted, so the list first scrolls to its message and waits for the row. Scrolling, clicking or a scroll key stops
 * a pending scroll; Escape also clears the highlight. Calls onSettled once with how it went.
 */
export function revealCitationInList({
  citation,
  messages,
  list,
  onSettled,
}: {
  citation: AssistantCitation;
  messages: readonly ChatMessage[];
  list: CitationRevealList | null;
  onSettled?: (outcome: CitationRevealOutcome) => void;
}): () => void {
  activeReveal?.();
  const scrollNode = list?.getScrollableNode();
  const root = scrollNode instanceof HTMLElement ? scrollNode : null;
  let stopped = false;
  let settled = false;
  let scrolling = false;
  let frame: number | null = null;
  let stopPulse: (() => void) | null = null;
  const settle = (outcome: CitationRevealOutcome) => {
    if (settled) return;
    settled = true;
    onSettled?.(outcome);
  };

  const dispose = () => {
    if (stopped) return;
    // A newer reveal or the list going away also stops this one's scroll.
    stopScroll();
    stopped = true;
    if (frame !== null) cancelAnimationFrame(frame);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("pointerdown", onNavigation, true);
    root?.removeEventListener("wheel", onWheel);
    root?.removeEventListener("touchmove", onNavigation);
    stopPulse?.();
    if (activeReveal === dispose) activeReveal = null;
  };
  // User navigation stops a pending scroll and leaves a finished highlight; Escape clears it either way.
  const stopScroll = () => {
    if (!scrolling || root === null || list === null) return;
    scrolling = false;
    if (!root.isConnected) return;
    void list.scrollToOffset({ offset: root.scrollTop, animated: false });
  };
  const onNavigation = () => {
    if (settled) return;
    stopScroll();
    dispose();
  };
  const onWheel = (event: WheelEvent) => {
    if (event.deltaY !== 0) onNavigation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      stopScroll();
      dispose();
    } else if (SCROLL_KEYS.has(event.key) && event.target instanceof Node && root?.contains(event.target) === true) {
      onNavigation();
    }
  };

  const highlight = (source: HTMLElement, range: Range | null) => {
    // Screen readers follow focus, not scroll; leave someone already typing alone.
    const active = source.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement) || !(active.isContentEditable || active.matches("input, textarea, select"))) {
      if (!source.hasAttribute("tabindex")) source.setAttribute("tabindex", "-1");
      source.focus({ preventScroll: true });
    }
    if (range === null) {
      settle("changed");
      dispose();
      return;
    }
    settle("highlighted");
    stopPulse = pulseCitation(source, citation, range, dispose);
  };

  const scrollTo = (source: HTMLElement) => {
    const range = resolveCitationRange(source, citation);
    if (root === null || list === null) {
      source.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      highlight(source, range);
      return;
    }
    const rect = (range ?? source).getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const offset = Math.max(0, Math.min(
      root.scrollHeight - root.clientHeight,
      root.scrollTop + rect.top - rootRect.top - Math.min(120, root.clientHeight / 3),
    ));
    if (Math.abs(offset - root.scrollTop) <= 1) {
      highlight(source, range);
      return;
    }
    scrolling = true;
    list.scrollToOffset({ offset, animated: !prefersReducedMotion() }).then(
      () => {
        if (stopped || !scrolling) return;
        scrolling = false;
        // The answer can re-render while the list scrolls; find the quote again in what is there now.
        const current = source.isConnected ? source : findCitationSource(root, citation);
        if (current === null) {
          settle("missing");
          dispose();
          return;
        }
        highlight(current, resolveCitationRange(current, citation));
      },
      () => {
        // A scroll cancelled on purpose rejects too; only a real failure reports the source missing.
        if (stopped || !scrolling) return;
        scrolling = false;
        settle("missing");
        dispose();
      },
    );
  };

  const waitForSource = (attempt: number) => {
    frame = null;
    if (stopped) return;
    const source = findCitationSource(root ?? document, citation);
    if (source !== null) {
      scrolling = false;
      scrollTo(source);
      return;
    }
    if (attempt >= REVEAL_MOUNT_FRAMES) {
      scrolling = false;
      settle("missing");
      dispose();
      return;
    }
    frame = requestAnimationFrame(() => { waitForSource(attempt + 1); });
  };

  activeReveal = dispose;
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("pointerdown", onNavigation, true);
  root?.addEventListener("wheel", onWheel, { passive: true });
  root?.addEventListener("touchmove", onNavigation, { passive: true });

  const mounted = findCitationSource(root ?? document, citation);
  if (mounted !== null) {
    scrollTo(mounted);
    return dispose;
  }
  const holder = findSourceMessage(messages, citation.sourceId);
  if (holder === null || list === null) {
    settle("missing");
    dispose();
    return dispose;
  }
  if (holder.folded && holder.messageId !== undefined) openDisclosure(`${holder.messageId}:worked`);
  // Pending until the row mounts, so Escape or the engineer's own scrolling can still stop it.
  scrolling = true;
  void list.scrollToIndex({ index: holder.index, animated: false, viewPosition: 0.3 });
  frame = requestAnimationFrame(() => { waitForSource(1); });
  return dispose;
}
