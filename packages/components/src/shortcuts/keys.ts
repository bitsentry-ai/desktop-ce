/**
 * Shortcut key parsing and matching. Pure functions, no React, so the matcher can be unit tested.
 *
 * A shortcut is a list of tokens. Modifier tokens (`mod`, `shift`, `alt`, `ctrl`, `meta`) attach to the next key,
 * and each non-modifier token ends one step. `["mod", "k"]` is one chord; `["g", "i"]` is a two-step sequence.
 * `mod` is Command on macOS and Control elsewhere.
 */

export type ShortcutKeys = readonly string[];

export interface ShortcutStep {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
}

/** What the matcher needs from a keyboard event. */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** Where focus is when the key is pressed. */
export interface ShortcutContext {
  /** Focus is in an input, textarea, select or contenteditable element. */
  editableFocus: boolean;
  /** A dialog other than the command palette is open. */
  otherDialogOpen: boolean;
}

export interface MatchableShortcut {
  keys?: ShortcutKeys;
}

export const SEQUENCE_TIMEOUT_MS = 1000;

const MODIFIER_TOKENS = new Set(["mod", "shift", "alt", "option", "ctrl", "control", "meta", "cmd", "command"]);
const MODIFIER_EVENT_KEYS = new Set(["shift", "alt", "control", "meta", "os", "altgraph", "capslock", "fn"]);
const IGNORED_EVENT_KEYS = new Set(["process", "dead", "unidentified"]);

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  " ": "space",
  spacebar: "space",
  del: "delete",
};

export function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

function isLetterOrDigit(key: string): boolean {
  if (key.length !== 1) return false;
  return (key >= "a" && key <= "z") || (key >= "0" && key <= "9");
}

function applyModifier(step: ShortcutStep, token: string): void {
  if (token === "mod") step.mod = true;
  else if (token === "shift") step.shift = true;
  else if (token === "alt" || token === "option") step.alt = true;
  else if (token === "ctrl" || token === "control") step.ctrl = true;
  else step.meta = true;
}

function emptyStep(): ShortcutStep {
  return { key: "", mod: false, shift: false, alt: false, ctrl: false, meta: false };
}

/** Splits tokens into steps: modifiers attach to the key that follows them. */
export function parseShortcut(keys: ShortcutKeys): ShortcutStep[] {
  const steps: ShortcutStep[] = [];
  let current = emptyStep();
  for (const raw of keys) {
    const token = raw.toLowerCase();
    if (MODIFIER_TOKENS.has(token)) {
      applyModifier(current, token);
      continue;
    }
    current.key = normalizeKeyName(raw);
    steps.push(current);
    current = emptyStep();
  }
  return steps;
}

/** A step with Command, Control or Option held; plain keys and Shift-only keys are not chords. */
export function isChordStep(step: ShortcutStep): boolean {
  return step.mod || step.ctrl || step.meta || step.alt;
}

/** True when a plain (unmodified) key could fire this shortcut, so it must not fire while typing. */
export function needsTypingGuard(keys: ShortcutKeys): boolean {
  const steps = parseShortcut(keys);
  return steps.length > 1 || steps.some((step) => !isChordStep(step));
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const withUaData = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (withUaData.userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
  return platform.startsWith("mac") || platform.startsWith("iphone") || platform.startsWith("ipad");
}

function expectedModifiers(step: ShortcutStep, isMac: boolean): { meta: boolean; ctrl: boolean } {
  return {
    meta: step.meta || (step.mod && isMac),
    ctrl: step.ctrl || (step.mod && !isMac),
  };
}

function eventKeyMatches(event: ShortcutKeyEvent, step: ShortcutStep): boolean {
  if (normalizeKeyName(event.key) === step.key) return true;
  // Option changes the produced character on macOS (Option+N is "˜"), so fall back to the physical key.
  if (!event.altKey || event.code === undefined || !isLetterOrDigit(step.key)) return false;
  const code = event.code.toLowerCase();
  return code === `key${step.key}` || code === `digit${step.key}`;
}

/** Whether one keydown satisfies one step on this platform. */
export function eventMatchesStep(event: ShortcutKeyEvent, step: ShortcutStep, isMac: boolean): boolean {
  const expected = expectedModifiers(step, isMac);
  if (event.metaKey !== expected.meta || event.ctrlKey !== expected.ctrl) return false;
  if (event.altKey !== step.alt) return false;
  // Shift is part of a letter shortcut, but produces symbols such as "?" itself, so it is ignored for those.
  if (isLetterOrDigit(step.key) || step.key.length > 1 || step.shift) {
    if (event.shiftKey !== step.shift) return false;
  }
  return eventKeyMatches(event, step);
}

function isIgnorableEvent(event: ShortcutKeyEvent): boolean {
  if (event.defaultPrevented === true || event.isComposing === true || event.repeat === true) return true;
  return IGNORED_EVENT_KEYS.has(event.key.toLowerCase());
}

export function isModifierOnlyEvent(event: ShortcutKeyEvent): boolean {
  return MODIFIER_EVENT_KEYS.has(event.key.toLowerCase());
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

const NON_TEXT_INPUT_TYPES = new Set(["button", "checkbox", "radio", "submit", "reset", "range", "color", "file", "image"]);

/** Input, textarea, select or contenteditable: places where letters are text, not commands. */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== "object") return false;
  const element = target as ElementLike;
  const tag = element.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element.getAttribute?.("type") ?? "text").toLowerCase();
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  if (element.isContentEditable === true) return true;
  return typeof element.closest === "function" && element.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** Marks the palette (and the shortcuts dialog) so open-dialog detection ignores them. */
export const COMMAND_PALETTE_ATTRIBUTE = "data-command-palette";

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';

/** True when a dialog, alert dialog or popover dialog other than the command palette is open. */
export function hasOpenDialogOutsidePalette(root: Pick<Document, "querySelectorAll"> | null | undefined): boolean {
  if (root === null || root === undefined) return false;
  for (const element of Array.from(root.querySelectorAll(DIALOG_SELECTOR))) {
    if (element.closest(`[${COMMAND_PALETTE_ATTRIBUTE}]`) !== null) continue;
    if (element.getAttribute("data-state") === "closed") continue;
    return true;
  }
  return false;
}

export interface ShortcutMatcherOptions {
  isMac?: boolean;
  sequenceTimeoutMs?: number;
  now?: () => number;
}

export type ShortcutMatch<T> = { kind: "run"; command: T } | { kind: "pending" } | null;

interface ParsedShortcut<T> {
  command: T;
  steps: ShortcutStep[];
  guarded: boolean;
}

function isBlocked(parsed: { steps: ShortcutStep[]; guarded: boolean }, context: ShortcutContext): boolean {
  if (context.otherDialogOpen) return true;
  return parsed.guarded && context.editableFocus;
}

/**
 * Tracks a pending sequence prefix (such as the "g" of "g i") across keydowns. The prefix expires by timestamp on
 * the next key, so no timer runs.
 */
export function createShortcutMatcher(options: ShortcutMatcherOptions = {}) {
  const isMac = options.isMac ?? isMacPlatform();
  const timeout = options.sequenceTimeoutMs ?? SEQUENCE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let pending: ShortcutKeyEvent[] = [];
  let pendingAt = 0;

  const reset = () => {
    pending = [];
    pendingAt = 0;
  };

  function matchFrom<T>(candidates: ParsedShortcut<T>[], history: ShortcutKeyEvent[]): ShortcutMatch<T> {
    let prefixMatched = false;
    for (const candidate of candidates) {
      if (candidate.steps.length < history.length) continue;
      const matches = history.every((event, index) => eventMatchesStep(event, candidate.steps[index], isMac));
      if (!matches) continue;
      if (candidate.steps.length === history.length) return { kind: "run", command: candidate.command };
      prefixMatched = true;
    }
    return prefixMatched ? { kind: "pending" } : null;
  }

  function handle<T extends MatchableShortcut>(
    event: ShortcutKeyEvent,
    commands: readonly T[],
    context: ShortcutContext,
  ): ShortcutMatch<T> {
    if (isIgnorableEvent(event) || isModifierOnlyEvent(event)) return null;
    const candidates = commands
      .filter((command) => command.keys !== undefined && command.keys.length > 0)
      .map((command) => {
        const keys = command.keys ?? [];
        return { command, steps: parseShortcut(keys), guarded: needsTypingGuard(keys) };
      })
      .filter((candidate) => candidate.steps.length > 0 && !isBlocked(candidate, context));

    const at = now();
    if (pending.length > 0 && at - pendingAt <= timeout) {
      const continued = matchFrom(candidates, [...pending, event]);
      if (continued?.kind === "pending") {
        pending = [...pending, event];
        pendingAt = at;
        return continued;
      }
      reset();
      if (continued !== null) return continued;
    }
    reset();

    const fresh = matchFrom(candidates, [event]);
    if (fresh?.kind === "pending") {
      pending = [event];
      pendingAt = at;
    }
    return fresh;
  }

  return { handle, reset };
}

export type ShortcutMatcher = ReturnType<typeof createShortcutMatcher>;
