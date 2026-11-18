import { CommandPalette, type CommandPaletteGroup } from "./CommandPalette";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsList";
import type { ShortcutCommand } from "./registry";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

export interface CommandPaletteHostProps {
  commands: readonly ShortcutCommand[];
  groups?: readonly CommandPaletteGroup[];
  placeholder?: string;
}

/**
 * Mount once inside `CommandPaletteProvider`: listens for the shortcuts and renders the palette and the `?`
 * shortcuts dialog.
 */
export function CommandPaletteHost({ commands, groups, placeholder }: CommandPaletteHostProps) {
  useGlobalShortcuts(commands);
  return (
    <>
      <CommandPalette commands={commands} groups={groups} placeholder={placeholder} />
      <KeyboardShortcutsDialog commands={commands} />
    </>
  );
}
