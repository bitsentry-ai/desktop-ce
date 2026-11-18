import { useEffect, useEffectEvent } from "react";
import {
  createShortcutMatcher,
  hasOpenDialogOutsidePalette,
  isEditableTarget,
  type ShortcutContext,
} from "./keys";
import type { ShortcutCommand } from "./registry";

/** Reads focus and open dialogs at the moment of the keydown. */
export function readShortcutContext(event: Pick<KeyboardEvent, "target">): ShortcutContext {
  const doc = typeof document === "undefined" ? null : document;
  return {
    editableFocus: isEditableTarget(event.target) || isEditableTarget(doc?.activeElement ?? null),
    otherDialogOpen: hasOpenDialogOutsidePalette(doc),
  };
}

/**
 * Runs `commands` from one window keydown listener. Plain keys and `g` sequences do not fire while typing in a
 * field or while another dialog is open; chords with ⌘/Ctrl still fire in fields. Removed on unmount.
 */
export function useGlobalShortcuts(commands: readonly ShortcutCommand[], enabled = true): void {
  const onKeyDown = useEffectEvent(
    (event: KeyboardEvent, matcher: ReturnType<typeof createShortcutMatcher>) => {
      const match = matcher.handle(event, commands, readShortcutContext(event));
      if (match?.kind !== "run") return;
      event.preventDefault();
      match.command.run();
    },
  );

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const matcher = createShortcutMatcher();
    const listener = (event: KeyboardEvent) => {
      onKeyDown(event, matcher);
    };
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      matcher.reset();
    };
  }, [enabled]);
}
