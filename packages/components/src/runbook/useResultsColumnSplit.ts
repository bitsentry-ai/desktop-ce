import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import {
  DEFAULT_RESULTS_COLUMN_SPLIT,
  columnSplitForKey,
  readColumnSplit,
  resizeColumnSplit,
  sameColumnSplit,
  writeColumnSplit,
  type ResultsColumnDivider,
  type ResultsColumnSplit,
} from "./resultsColumnSplit";

interface DragState {
  divider: ResultsColumnDivider;
  pointerId: number;
  startX: number;
  startSplit: ResultsColumnSplit;
}

export interface ResultsColumnDividerHandlers {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick: () => void;
}

/**
 * Column widths for the Results detail, resizable by dragging a divider or
 * with the arrow keys on it, and remembered across sessions.
 *
 * Only the panel container re-renders while dragging: the panel bodies are
 * elements handed in by the page, so React skips them.
 */
export function useResultsColumnSplit() {
  const [split, setSplit] = useState<ResultsColumnSplit>(() =>
    readColumnSplit(),
  );
  const [draggingDivider, setDraggingDivider] =
    useState<ResultsColumnDivider | null>(null);
  const splitRef = useRef<ResultsColumnSplit>(split);
  const dragRef = useRef<DragState | null>(null);

  const applySplit = (next: ResultsColumnSplit) => {
    if (sameColumnSplit(next, splitRef.current)) return;
    splitRef.current = next;
    setSplit(next);
  };

  const commitSplit = (next: ResultsColumnSplit) => {
    applySplit(next);
    writeColumnSplit(next);
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingDivider(null);
    writeColumnSplit(splitRef.current);
  };

  const dividerHandlers = (
    divider: ResultsColumnDivider,
  ): ResultsColumnDividerHandlers => ({
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      // Keeps the drag from starting a text selection across the columns.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        divider,
        pointerId: event.pointerId,
        startX: event.clientX,
        startSplit: splitRef.current,
      };
      setDraggingDivider(divider);
    },
    onPointerMove: (event) => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      applySplit(
        resizeColumnSplit(
          drag.startSplit,
          drag.divider,
          event.clientX - drag.startX,
        ),
      );
    },
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onKeyDown: (event) => {
      const next = columnSplitForKey(splitRef.current, divider, event.key);
      if (next === null) return;
      event.preventDefault();
      commitSplit(next);
    },
    onDoubleClick: () => {
      commitSplit(DEFAULT_RESULTS_COLUMN_SPLIT);
    },
  });

  return { split, draggingDivider, dividerHandlers };
}
