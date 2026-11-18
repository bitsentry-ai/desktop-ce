import { useId, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, X } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { useCommandPalette } from "./CommandPaletteContext";
import { filterByQuery } from "./filter";
import { Kbd } from "./Kbd";
import { COMMAND_PALETTE_ATTRIBUTE } from "./keys";
import { SHORTCUT_GROUP_LABEL_KEYS, type ShortcutCommand } from "./registry";

export interface KeyboardShortcutsListProps {
  commands: readonly ShortcutCommand[];
  /** Shows a search field above the list. Default true. */
  searchable?: boolean;
  className?: string;
}

interface Row {
  id: string;
  label: string;
  keywords?: readonly string[];
  keys: readonly string[];
  group: string;
}

/** Read-only list of shortcuts grouped like the palette, with keycaps on the right. For settings pages. */
export function KeyboardShortcutsList({ commands, searchable = true, className }: KeyboardShortcutsListProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const baseId = useId();

  const rows: Row[] = commands
    .filter((command) => command.keys !== undefined && command.keys.length > 0)
    .map((command) => ({
      id: command.id,
      label: command.label ?? t(command.labelKey ?? command.id),
      keywords: command.keywords,
      keys: command.keys ?? [],
      group: command.group,
    }));
  const matching = filterByQuery(query, rows, (row) => ({ label: row.label, keywords: row.keywords }));
  const groupOrder = [...new Set(rows.map((row) => row.group))];
  const groups = groupOrder
    .map((group) => ({ group, rows: matching.filter((row) => row.group === group) }))
    .filter((entry) => entry.rows.length > 0);

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      {searchable && (
        <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder={t("common.shortcuts.searchShortcutsPlaceholder")}
            aria-label={t("common.shortcuts.searchShortcutsPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className="h-full w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      )}
      {groups.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("common.shortcuts.noShortcuts")}</p>
      )}
      {groups.map(({ group, rows: groupRows }) => {
        const headingId = `${baseId}-${group}`;
        const labelKey = SHORTCUT_GROUP_LABEL_KEYS[group];
        return (
          <section key={group} aria-labelledby={headingId} className="flex flex-col gap-2">
            <h3 id={headingId} className="text-sm font-semibold text-foreground">
              {labelKey === undefined ? group : t(labelKey)}
            </h3>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {groupRows.map((row) => (
                <li key={row.id} className="flex min-h-11 items-center justify-between gap-4 px-3 py-2">
                  <span className="min-w-0 truncate text-sm text-foreground">{row.label}</span>
                  <Kbd keys={row.keys} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export interface KeyboardShortcutsDialogProps {
  commands: readonly ShortcutCommand[];
  /** Controlled open state; defaults to the `CommandPaletteProvider` shortcuts state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** The `?` dialog: the keyboard shortcuts list in a small modal. */
export function KeyboardShortcutsDialog({ commands, open: openProp, onOpenChange }: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation();
  const palette = useCommandPalette();
  const open = openProp ?? palette.shortcutsOpen;
  const setOpen = onOpenChange ?? palette.setShortcutsOpen;
  const paletteMarker = { [COMMAND_PALETTE_ATTRIBUTE]: "" };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          {...paletteMarker}
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold text-foreground">
              {t("common.shortcuts.title")}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("common.actions.close")}
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-4">
            <KeyboardShortcutsList commands={commands} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
