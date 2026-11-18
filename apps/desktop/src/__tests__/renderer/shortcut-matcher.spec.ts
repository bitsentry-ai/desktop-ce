// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  COMMAND_PALETTE_ATTRIBUTE,
  createShortcutMatcher,
  hasOpenDialogOutsidePalette,
  isEditableTarget,
  parseShortcut,
  type ShortcutContext,
  type ShortcutKeyEvent,
} from "@bitsentry-ce/components/shortcuts/keys";
import { defaultNavigationCommands } from "@bitsentry-ce/components/shortcuts/registry";
import { filterByQuery } from "@bitsentry-ce/components/shortcuts/filter";
import { keyGlyph } from "@bitsentry-ce/components/shortcuts/Kbd";

type Command = { id: string; keys: string[] };

const FREE: ShortcutContext = { editableFocus: false, otherDialogOpen: false };
const TYPING: ShortcutContext = { editableFocus: true, otherDialogOpen: false };
const DIALOG: ShortcutContext = { editableFocus: false, otherDialogOpen: true };

const commands: Command[] = [
  { id: "palette", keys: ["mod", "k"] },
  { id: "theme", keys: ["mod", "\\"] },
  { id: "incidents", keys: ["g", "i"] },
  { id: "runbooks", keys: ["g", "r"] },
  { id: "new", keys: ["c"] },
  { id: "help", keys: ["?"] },
];

function key(value: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return { key: value, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers };
}

function ran(result: ReturnType<ReturnType<typeof createShortcutMatcher>["handle"]>): string | null {
  return result?.kind === "run" ? (result.command as Command).id : null;
}

describe("parseShortcut", () => {
  it("attaches modifiers to the key after them and splits sequences into steps", () => {
    expect(parseShortcut(["mod", "shift", "K"])).toEqual([
      { key: "k", mod: true, shift: true, alt: false, ctrl: false, meta: false },
    ]);
    expect(parseShortcut(["g", "i"]).map((step) => step.key)).toEqual(["g", "i"]);
    expect(parseShortcut(["esc"])[0].key).toBe("escape");
  });
});

describe("mod mapping", () => {
  it("maps mod to Command on macOS and ignores Control", () => {
    const matcher = createShortcutMatcher({ isMac: true });
    expect(ran(matcher.handle(key("k", { metaKey: true }), commands, FREE))).toBe("palette");
    expect(matcher.handle(key("k", { ctrlKey: true }), commands, FREE)).toBeNull();
  });

  it("maps mod to Control elsewhere and ignores the Windows key", () => {
    const matcher = createShortcutMatcher({ isMac: false });
    expect(ran(matcher.handle(key("k", { ctrlKey: true }), commands, FREE))).toBe("palette");
    expect(matcher.handle(key("k", { metaKey: true }), commands, FREE)).toBeNull();
    expect(ran(matcher.handle(key("\\", { ctrlKey: true }), commands, FREE))).toBe("theme");
  });

  it("does not run a chord with an extra modifier, a repeat, or during IME composition", () => {
    const matcher = createShortcutMatcher({ isMac: true });
    expect(matcher.handle(key("k", { metaKey: true, shiftKey: true }), commands, FREE)).toBeNull();
    expect(matcher.handle(key("k", { metaKey: true, repeat: true }), commands, FREE)).toBeNull();
    expect(matcher.handle(key("k", { metaKey: true, isComposing: true }), commands, FREE)).toBeNull();
  });

  it("matches a shifted symbol such as ? without listing shift", () => {
    const matcher = createShortcutMatcher({ isMac: true });
    expect(ran(matcher.handle(key("?", { shiftKey: true }), commands, FREE))).toBe("help");
    // Shift+C is a capital letter, not the c shortcut.
    expect(matcher.handle(key("C", { shiftKey: true }), commands, FREE)).toBeNull();
    expect(ran(matcher.handle(key("c"), commands, FREE))).toBe("new");
  });
});

describe("input focus and dialog guard", () => {
  it("blocks single letters and g sequences while typing, but not mod chords", () => {
    const matcher = createShortcutMatcher({ isMac: true });
    expect(matcher.handle(key("c"), commands, TYPING)).toBeNull();
    expect(matcher.handle(key("?", { shiftKey: true }), commands, TYPING)).toBeNull();
    expect(matcher.handle(key("g"), commands, TYPING)).toBeNull();
    expect(matcher.handle(key("i"), commands, TYPING)).toBeNull();
    expect(ran(matcher.handle(key("k", { metaKey: true }), commands, TYPING))).toBe("palette");
  });

  it("blocks every shortcut while another dialog is open", () => {
    const matcher = createShortcutMatcher({ isMac: true });
    expect(matcher.handle(key("c"), commands, DIALOG)).toBeNull();
    expect(matcher.handle(key("k", { metaKey: true }), commands, DIALOG)).toBeNull();
  });

  it("treats inputs, textareas, selects and contenteditable as editable", () => {
    const input = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.append(inner);
    document.body.append(editor);

    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
    expect(isEditableTarget(inner)).toBe(true);
    expect(isEditableTarget(checkbox)).toBe(false);
    expect(isEditableTarget(document.createElement("button"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  describe("open dialog detection", () => {
    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("ignores the command palette and closed dialogs", () => {
      const palette = document.createElement("div");
      palette.setAttribute("role", "dialog");
      palette.setAttribute(COMMAND_PALETTE_ATTRIBUTE, "");
      const closed = document.createElement("div");
      closed.setAttribute("role", "dialog");
      closed.setAttribute("data-state", "closed");
      document.body.append(palette, closed);
      expect(hasOpenDialogOutsidePalette(document)).toBe(false);

      const alert = document.createElement("div");
      alert.setAttribute("role", "alertdialog");
      alert.setAttribute("data-state", "open");
      document.body.append(alert);
      expect(hasOpenDialogOutsidePalette(document)).toBe(true);
    });
  });
});

describe("g sequences", () => {
  it("runs the second key within the timeout", () => {
    let now = 0;
    const matcher = createShortcutMatcher({ isMac: true, now: () => now });
    expect(matcher.handle(key("g"), commands, FREE)).toEqual({ kind: "pending" });
    now = 400;
    expect(ran(matcher.handle(key("r"), commands, FREE))).toBe("runbooks");
    // The sequence is consumed: a lone "r" afterwards does nothing.
    expect(matcher.handle(key("r"), commands, FREE)).toBeNull();
  });

  it("expires the prefix after about a second", () => {
    let now = 0;
    const matcher = createShortcutMatcher({ isMac: true, now: () => now, sequenceTimeoutMs: 1000 });
    matcher.handle(key("g"), commands, FREE);
    now = 1001;
    expect(matcher.handle(key("i"), commands, FREE)).toBeNull();
  });

  it("drops the prefix on an unrelated key and still runs that key's own shortcut", () => {
    const matcher = createShortcutMatcher({ isMac: true, now: () => 0 });
    matcher.handle(key("g"), commands, FREE);
    expect(ran(matcher.handle(key("c"), commands, FREE))).toBe("new");
    expect(matcher.handle(key("i"), commands, FREE)).toBeNull();
  });

  it("keeps the prefix across a bare modifier keydown, and reset clears it", () => {
    const matcher = createShortcutMatcher({ isMac: true, now: () => 0 });
    matcher.handle(key("g"), commands, FREE);
    expect(matcher.handle(key("Shift", { shiftKey: true }), commands, FREE)).toBeNull();
    expect(ran(matcher.handle(key("i"), commands, FREE))).toBe("incidents");

    matcher.handle(key("g"), commands, FREE);
    matcher.reset();
    expect(matcher.handle(key("i"), commands, FREE)).toBeNull();
  });
});

describe("defaultNavigationCommands", () => {
  it("navigates with per-app routes and leaves out actions without a handler", () => {
    const visited: string[] = [];
    const list = defaultNavigationCommands((to) => visited.push(to), { routes: { settings: "/app-settings" } });
    expect(list.map((command) => command.keys?.join(" "))).toEqual(["g i", "g r", "g e", "g n", "g s"]);
    list.find((command) => command.id === "navigate.settings")?.run();
    expect(visited).toEqual(["/app-settings"]);

    const withActions = defaultNavigationCommands(() => {}, {
      togglePalette: () => {},
      newIncident: () => {},
      showShortcuts: () => {},
      toggleTheme: () => {},
    });
    expect(withActions.filter((command) => command.group === "actions").map((command) => command.keys)).toEqual([
      ["mod", "k"],
      ["c"],
      ["?"],
      ["mod", "\\"],
    ]);
  });
});

describe("palette helpers", () => {
  it("filters case-insensitively, prefix first, with in-order letters as a fallback", () => {
    const items = ["Go to Runbooks", "Go to Results", "Runbook drift"];
    expect(filterByQuery("RUN", items, (label) => ({ label }))).toEqual(["Runbook drift", "Go to Runbooks"]);
    expect(filterByQuery("gtrs", items, (label) => ({ label }))).toEqual(["Go to Runbooks", "Go to Results"]);
    expect(filterByQuery("zzz", items, (label) => ({ label }))).toEqual([]);
  });

  it("draws platform glyphs", () => {
    expect(["mod", "shift", "alt", "ctrl", "enter", "escape"].map((token) => keyGlyph(token, true))).toEqual([
      "⌘",
      "⇧",
      "⌥",
      "⌃",
      "↵",
      "Esc",
    ]);
    expect(keyGlyph("mod", false)).toBe("Ctrl");
    expect(keyGlyph("k", false)).toBe("K");
  });
});
