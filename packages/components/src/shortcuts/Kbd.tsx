import { Fragment, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { isMacPlatform, normalizeKeyName, type ShortcutKeys } from "./keys";

const MAC_GLYPHS: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  ctrl: "⌃",
  control: "⌃",
  enter: "↵",
  backspace: "⌫",
  tab: "⇥",
};

// Key names printed on Windows and Linux keyboards; drawn capitalised ("ctrl" becomes "Ctrl"), never translated.
const OTHER_KEY_NAMES: Record<string, string> = {
  mod: "ctrl",
  control: "ctrl",
  meta: "win",
  cmd: "win",
  command: "win",
  option: "alt",
};

const OTHER_SYMBOLS: Record<string, string> = {
  enter: "↵",
  backspace: "⌫",
};

const SHARED_KEY_NAMES: Record<string, string> = {
  escape: "esc",
  delete: "del",
};

const ARROW_ICONS: Record<string, typeof ArrowUp> = {
  arrowup: ArrowUp,
  arrowdown: ArrowDown,
  arrowleft: ArrowLeft,
  arrowright: ArrowRight,
};

const MODIFIER_TOKENS = new Set(["mod", "cmd", "command", "meta", "shift", "alt", "option", "ctrl", "control"]);

/** The text drawn on a keycap for one token on this platform. */
export function keyGlyph(token: string, isMac: boolean = isMacPlatform()): string {
  const lower = token.toLowerCase();
  const symbol = isMac ? MAC_GLYPHS[lower] : OTHER_SYMBOLS[lower];
  if (symbol !== undefined) return symbol;
  const normalized = normalizeKeyName(token);
  const name = (isMac ? undefined : OTHER_KEY_NAMES[lower]) ?? SHARED_KEY_NAMES[normalized] ?? normalized;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Groups tokens into steps the same way the matcher does: modifiers stay with the key after them. */
function splitSteps(keys: ShortcutKeys): string[][] {
  const steps: string[][] = [];
  let current: string[] = [];
  for (const token of keys) {
    current.push(token);
    if (!MODIFIER_TOKENS.has(token.toLowerCase())) {
      steps.push(current);
      current = [];
    }
  }
  if (current.length > 0) steps.push(current);
  return steps;
}

const KEYCAP_CLASS =
  "inline-flex h-5 min-w-5 select-none items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[11px] font-medium leading-none tabular-nums text-muted-foreground";

export function Keycap({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn(KEYCAP_CLASS, className)}>{children}</kbd>;
}

function KeycapContent({ token, isMac }: { token: string; isMac: boolean }) {
  const Arrow = ARROW_ICONS[normalizeKeyName(token)];
  if (Arrow !== undefined) return <Arrow className="size-3" aria-hidden="true" />;
  return <>{keyGlyph(token, isMac)}</>;
}

export interface KbdProps {
  /** Tokens such as `["mod", "k"]` (one chord) or `["g", "i"]` (press g, then i). */
  keys: ShortcutKeys;
  className?: string;
  /** Overrides platform detection, for previews and tests. */
  isMac?: boolean;
}

/** Keycaps for a shortcut with platform glyphs: ⌘ ⇧ ⌥ ⌃ on macOS, Ctrl Shift Alt elsewhere. */
export function Kbd({ keys, className, isMac }: KbdProps) {
  const { t } = useTranslation();
  const mac = isMac ?? isMacPlatform();
  const steps = splitSteps(keys);
  const label = steps.map((step) => step.map((token) => keyGlyph(token, mac)).join(mac ? "" : "+")).join(" ");
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)} aria-label={label} role="img">
      {steps.map((step, stepIndex) => (
        <Fragment key={`${stepIndex}-${step.join("+")}`}>
          {stepIndex > 0 && (
            <span className="px-0.5 text-[11px] text-muted-foreground" aria-hidden="true">
              {t("common.shortcuts.then")}
            </span>
          )}
          {step.map((token, tokenIndex) => (
            <Keycap key={`${tokenIndex}-${token}`}>
              <KeycapContent token={token} isMac={mac} />
            </Keycap>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
