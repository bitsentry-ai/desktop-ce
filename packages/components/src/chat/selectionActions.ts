/**
 * When to show, move and hide an action that floats next to a text selection. Adapted from T3 Code's selection
 * actions (https://github.com/pingdotgg/t3code, MIT).
 */

export interface SelectionActionPoint {
  x: number;
  y: number;
}

const SELECTION_SCROLL_SETTLE_MS = 150;

/** The action's corner: where the pointer let go, else under the end of the selection, kept inside the bounds and window. */
export function resolveSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: SelectionActionPoint | null;
  viewport: { width: number; height: number };
}): SelectionActionPoint {
  const { bounds, selectionRect, pointer, viewport } = options;
  const preferred = pointer ?? {
    x: selectionRect?.right ?? bounds.left + bounds.width - 140,
    y: selectionRect ? selectionRect.bottom + 4 : bounds.top + 12,
  };
  return {
    x: Math.max(8, Math.min(Math.max(bounds.left, preferred.x), bounds.left + bounds.width, viewport.width - 8)),
    y: Math.max(8, Math.min(Math.max(bounds.top, preferred.y), bounds.top + bounds.height, viewport.height - 8)),
  };
}

export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function isSelectionRectVisible(rect: SelectionRect, clips: readonly SelectionRect[]): boolean {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

export interface SelectionActions {
  readonly pending: boolean;
  cancel: () => void;
  selectionChanged: () => void;
  dispose: () => void;
}

/**
 * Watches a scroll container for finished selections. A drag reports where the pointer let go; a double or triple
 * click reports at once with no pointer, so the action sits under the selection, clear of the next click. Scrolling
 * hides the action and brings it back once the scroll settles.
 */
export function observeSelectionActions({
  element,
  getActionElement,
  onSelection,
  onDismiss,
}: {
  element: HTMLElement;
  getActionElement: () => HTMLElement | null;
  onSelection: (pointer: SelectionActionPoint | null) => void;
  onDismiss: () => void;
}): SelectionActions {
  const document = element.ownerDocument;
  const view = document.defaultView ?? window;
  let pointerDown = false;
  let gestureActive = false;
  let dismissed = false;
  let restorable = false;
  let pointer: SelectionActionPoint | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;

  const isActionTarget = (target: EventTarget | null) =>
    target instanceof Node && (getActionElement()?.contains(target) ?? false);

  const cancelPending = () => {
    if (timer !== null) clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    timer = frame = null;
  };
  const cancel = () => {
    cancelPending();
    pointerDown = gestureActive = false;
    pointer = null;
    dismissed = true;
    restorable = false;
  };
  const dismiss = () => {
    cancel();
    onDismiss();
  };
  const schedule = (delay: number) => {
    restorable = true;
    cancelPending();
    timer = setTimeout(() => {
      timer = null;
      frame = requestAnimationFrame(() => {
        frame = null;
        onSelection(pointer);
      });
    }, delay);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    if (isActionTarget(event.target)) {
      cancel();
      return;
    }
    cancelPending();
    pointerDown = event.button === 0;
    gestureActive = false;
    dismissed = true;
    restorable = false;
    pointer = null;
    onDismiss();
  };
  const onSelectionStart = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, [role=button]")) return;
    gestureActive = event.button === 0 && !event.defaultPrevented;
    dismissed = !gestureActive;
  };
  const onPointerUp = (event: PointerEvent) => {
    // Preventing pointerdown (for example on the action itself) can suppress mouseup.
    if (event.isPrimary && event.button === 0) pointerDown = false;
  };
  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0) return;
    pointerDown = false;
    if (!gestureActive) return;
    gestureActive = false;
    const multiClick = event.detail >= 2;
    pointer = multiClick ? null : { x: event.clientX, y: event.clientY };
    schedule(0);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isActionTarget(event.target) && event.key !== "Escape") return;
    if (event.key === "Escape") {
      dismiss();
    } else if (!pointerDown) {
      // Keyboard selection (Shift+arrows) shows the action under the selection.
      cancelPending();
      gestureActive = false;
      pointer = null;
      dismissed = false;
    }
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isActionTarget(event.target)) cancel();
    else if (!pointerDown && getActionElement() !== null) dismiss();
  };
  const onScroll = () => {
    cancelPending();
    // Autoscroll during a drag must not cancel that gesture's eventual release.
    if (!pointerDown) {
      pointer = null;
      if (!dismissed && restorable) schedule(SELECTION_SCROLL_SETTLE_MS);
      else dismissed = true;
    }
    onDismiss();
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  element.addEventListener("pointerdown", onSelectionStart);
  view.addEventListener("pointerup", onPointerUp);
  view.addEventListener("mouseup", onMouseUp);
  view.addEventListener("pointercancel", dismiss);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocusIn);
  element.addEventListener("contextmenu", dismiss, true);
  element.addEventListener("scroll", onScroll, true);
  view.addEventListener("blur", dismiss);
  view.addEventListener("resize", dismiss);

  return {
    get pending() {
      return timer !== null || frame !== null;
    },
    cancel,
    selectionChanged() {
      if (isActionTarget(document.activeElement)) return;
      if (pointerDown || gestureActive) {
        onDismiss();
      } else if (!dismissed && timer === null && frame === null) {
        schedule(0);
      }
    },
    dispose() {
      cancel();
      document.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointerdown", onSelectionStart);
      view.removeEventListener("pointerup", onPointerUp);
      view.removeEventListener("mouseup", onMouseUp);
      view.removeEventListener("pointercancel", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("contextmenu", dismiss, true);
      element.removeEventListener("scroll", onScroll, true);
      view.removeEventListener("blur", dismiss);
      view.removeEventListener("resize", dismiss);
    },
  };
}
