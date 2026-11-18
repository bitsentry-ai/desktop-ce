import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface CommandPaletteState {
  /** False outside a `CommandPaletteProvider`, so a button using it can hide itself. */
  available: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
  openShortcuts: () => void;
}

const noop = () => {};

const UNAVAILABLE: CommandPaletteState = {
  available: false,
  open: false,
  setOpen: noop,
  openPalette: noop,
  closePalette: noop,
  togglePalette: noop,
  shortcutsOpen: false,
  setShortcutsOpen: noop,
  openShortcuts: noop,
};

const CommandPaletteContext = createContext<CommandPaletteState>(UNAVAILABLE);

/** Holds whether the command palette and the keyboard shortcuts dialog are open. Only one is open at a time. */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [shortcutsOpen, setShortcutsOpenState] = useState(false);

  const value = useMemo((): CommandPaletteState => {
    const setOpen = (next: boolean) => {
      if (next) setShortcutsOpenState(false);
      setOpenState(next);
    };
    const setShortcutsOpen = (next: boolean) => {
      if (next) setOpenState(false);
      setShortcutsOpenState(next);
    };
    return {
      available: true,
      open,
      setOpen,
      openPalette: () => {
        setOpen(true);
      },
      closePalette: () => {
        setOpen(false);
      },
      togglePalette: () => {
        setOpen(!open);
      },
      shortcutsOpen,
      setShortcutsOpen,
      openShortcuts: () => {
        setShortcutsOpen(true);
      },
    };
  }, [open, shortcutsOpen]);

  return <CommandPaletteContext.Provider value={value}>{children}</CommandPaletteContext.Provider>;
}

/** Opens and closes the command palette, for a "Search ⌘K" button. Inert outside a provider. */
export function useCommandPalette(): CommandPaletteState {
  return useContext(CommandPaletteContext);
}
