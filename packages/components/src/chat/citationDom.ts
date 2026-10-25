/**
 * Reading quotes out of rendered agent text, and finding them again, adapted
 * from T3 Code's assistant text selection (https://github.com/pingdotgg/t3code,
 * MIT). A source's text is its text nodes in order, with a line break between
 * blocks, so a quote across paragraphs keeps them apart.
 */

import { buildCitation, findCitationRange, type AssistantCitation } from "./citations";

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

/** The citation for the current selection, when it sits inside one agent text source in the viewport. */
export function captureSelectionCitation(viewport: Element, threadId: string): { citation: AssistantCitation; rect: DOMRect } | null {
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
  const rects = range.getClientRects();
  return { citation, rect: rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect() };
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
  const locate = (offset: number) => {
    for (let index = sourceText.nodes.length - 1; index >= 0; index--) {
      const entry = sourceText.nodes[index];
      if (entry.start <= offset) return { node: entry.node, offset: Math.min(offset - entry.start, entry.node.length) };
    }
    return null;
  };
  const startPoint = locate(rawStart);
  const endPoint = locate(rawEnd);
  if (startPoint === null || endPoint === null) return null;
  const range = source.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

const HIGHLIGHT_NAME = "bitsentry-citation";

/** Scrolls to a cited quote and highlights it for a moment. */
export function revealCitation(root: ParentNode, citation: AssistantCitation): boolean {
  const source = [...root.querySelectorAll(`[${CITATION_SOURCE_ATTRIBUTE}]`)]
    .find((element) => element.getAttribute(CITATION_SOURCE_ATTRIBUTE) === citation.sourceId);
  if (source === undefined) return false;
  source.scrollIntoView({ block: "center", behavior: "smooth" });
  const range = resolveCitationRange(source, citation);
  if (range === null) return true;

  const highlights = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const HighlightConstructor = (globalThis as { Highlight?: new (range: Range) => unknown }).Highlight;
  if (highlights !== undefined && HighlightConstructor !== undefined) {
    highlights.set(HIGHLIGHT_NAME, new HighlightConstructor(range));
    setTimeout(() => { highlights.delete(HIGHLIGHT_NAME); }, 2_000);
    return true;
  }
  const selection = source.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}
