import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { useCommandPalette } from "./CommandPaletteContext";
import { filterByQuery } from "./filter";
import { Kbd, Keycap } from "./Kbd";
import { COMMAND_PALETTE_ATTRIBUTE, type ShortcutKeys } from "./keys";
import { SHORTCUT_GROUP_LABEL_KEYS, type ShortcutCommand, type ShortcutIcon } from "./registry";

/** A palette row from app data, such as a recent incident. */
export interface CommandPaletteItem {
  id: string;
  /** Shown as is; already in the user's language or user content. */
  label: string;
  /** Secondary text on the right, such as a status or date. */
  hint?: string;
  icon?: ShortcutIcon;
  keys?: ShortcutKeys;
  keywords?: readonly string[];
  run: () => void;
}

/** A dynamic group shown after Navigation and Actions. */
export interface CommandPaletteGroup {
  id: string;
  /** Heading already in the user's language. */
  heading: string;
  items: readonly CommandPaletteItem[];
}

export interface CommandPaletteProps {
  commands: readonly ShortcutCommand[];
  groups?: readonly CommandPaletteGroup[];
  /** Controlled open state; defaults to the `CommandPaletteProvider` state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  /** Rows each dynamic group shows before the user types. Default 5. */
  idleGroupLimit?: number;
  /** Rows each dynamic group shows while searching. Default 8. */
  searchGroupLimit?: number;
}

type Translate = (key: string) => string;

interface ResolvedGroup {
  id: string;
  heading: string;
  items: CommandPaletteItem[];
}

function commandToItem(command: ShortcutCommand, t: Translate): CommandPaletteItem {
  return {
    id: command.id,
    label: command.label ?? t(command.labelKey ?? command.id),
    icon: command.icon,
    keys: command.keys,
    keywords: command.keywords,
    run: command.run,
  };
}

function commandGroupHeading(group: string, t: Translate): string {
  const key = SHORTCUT_GROUP_LABEL_KEYS[group];
  return key === undefined ? group : t(key);
}

function commandGroups(commands: readonly ShortcutCommand[], t: Translate): ResolvedGroup[] {
  const order: string[] = ["navigation", "actions"];
  const byGroup = new Map<string, CommandPaletteItem[]>();
  for (const command of commands) {
    if (command.hideInPalette === true) continue;
    if (!order.includes(command.group)) order.push(command.group);
    const list = byGroup.get(command.group) ?? [];
    list.push(commandToItem(command, t));
    byGroup.set(command.group, list);
  }
  return order
    .filter((group) => byGroup.has(group))
    .map((group) => ({ id: group, heading: commandGroupHeading(group, t), items: byGroup.get(group) ?? [] }));
}

function visibleGroups(
  query: string,
  groups: readonly ResolvedGroup[],
  dynamicIds: ReadonlySet<string>,
  limit: number,
): ResolvedGroup[] {
  return groups
    .map((group) => {
      const items = filterByQuery(query, group.items, (item) => ({ label: item.label, keywords: item.keywords }));
      return { ...group, items: dynamicIds.has(group.id) ? items.slice(0, limit) : items };
    })
    .filter((group) => group.items.length > 0);
}

function PaletteFooter({ t }: { t: Translate }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Keycap>
          <ArrowUp className="size-3" aria-hidden="true" />
        </Keycap>
        <Keycap>
          <ArrowDown className="size-3" aria-hidden="true" />
        </Keycap>
        {t("common.shortcuts.footer.navigate")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd keys={["enter"]} />
        {t("common.shortcuts.footer.select")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Kbd keys={["escape"]} />
        {t("common.shortcuts.footer.close")}
      </span>
    </div>
  );
}

interface PaletteRowProps {
  item: CommandPaletteItem;
  optionId: string;
  active: boolean;
  onHover: () => void;
  onRun: () => void;
}

function PaletteRow({ item, optionId, active, onHover, onRun }: PaletteRowProps) {
  const Icon = item.icon;
  return (
    <div
      id={optionId}
      role="option"
      aria-selected={active}
      data-active={active ? "true" : undefined}
      onMouseMove={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onRun}
      className={cn(
        "flex min-h-8 cursor-pointer select-none items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-foreground",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {Icon !== undefined && <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.hint !== undefined && item.hint.length > 0 && (
        <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{item.hint}</span>
      )}
      {item.keys !== undefined && item.keys.length > 0 && <Kbd keys={item.keys} className="ms-1" />}
    </div>
  );
}

interface PaletteBodyProps {
  commands: readonly ShortcutCommand[];
  groups: readonly CommandPaletteGroup[];
  placeholder?: string;
  idleGroupLimit: number;
  searchGroupLimit: number;
  close: () => void;
}

/** Mounted only while open, so the query and selection start fresh each time. */
function PaletteBody({ commands, groups, placeholder, idleGroupLimit, searchGroupLimit, close }: PaletteBodyProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const dynamicIds = new Set(groups.map((group) => group.id));
  const allGroups: ResolvedGroup[] = [
    ...commandGroups(commands, t),
    ...groups.map((group) => ({ id: group.id, heading: group.heading, items: [...group.items] })),
  ];
  const limit = query.trim().length > 0 ? searchGroupLimit : idleGroupLimit;
  const shown = visibleGroups(query, allGroups, dynamicIds, limit);
  const flat = shown.flatMap((group) => group.items);
  const groupStarts = shown.map((_, index) =>
    shown.slice(0, index).reduce((total, group) => total + group.items.length, 0),
  );
  const current = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (row !== null && row !== undefined && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [current]);

  const run = (item: CommandPaletteItem | undefined) => {
    if (item === undefined) return;
    close();
    item.run();
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
    setActiveIndex((current + delta + flat.length) % flat.length);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[current]);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          aria-label={t("common.shortcuts.paletteTitle")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t("common.shortcuts.searchPlaceholder")}
          spellCheck={false}
          autoComplete="off"
          className="h-12 w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("common.shortcuts.paletteTitle")}
        className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-1.5"
      >
        {flat.length === 0 && (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">{t("common.shortcuts.noResults")}</p>
        )}
        {shown.map((group, groupIndex) => {
          const start = groupStarts[groupIndex];
          const headingId = `${baseId}-group-${group.id}`;
          return (
            <div key={group.id} role="group" aria-labelledby={headingId} className="pb-1 last:pb-0">
              <div id={headingId} className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                {group.heading}
              </div>
              {group.items.map((item, index) => {
                const flatIndex = start + index;
                return (
                  <PaletteRow
                    key={`${group.id}:${item.id}`}
                    item={item}
                    optionId={optionId(flatIndex)}
                    active={flatIndex === current}
                    onHover={() => {
                      if (flatIndex !== current) setActiveIndex(flatIndex);
                    }}
                    onRun={() => {
                      run(item);
                    }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <PaletteFooter t={t} />
    </>
  );
}

/**
 * ⌘K command palette: a search field over grouped commands and app data. Arrow keys move, Enter runs, Esc closes.
 * Reads its open state from `CommandPaletteProvider` unless `open` is passed.
 */
export function CommandPalette({
  commands,
  groups = [],
  open: openProp,
  onOpenChange,
  placeholder,
  idleGroupLimit = 5,
  searchGroupLimit = 8,
}: CommandPaletteProps) {
  const { t } = useTranslation();
  const palette = useCommandPalette();
  const open = openProp ?? palette.open;
  const setOpen = onOpenChange ?? palette.setOpen;
  const paletteMarker = { [COMMAND_PALETTE_ATTRIBUTE]: "" };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/20 dark:bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          {...paletteMarker}
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 flex w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
        >
          <DialogPrimitive.Title className="sr-only">{t("common.shortcuts.paletteTitle")}</DialogPrimitive.Title>
          <PaletteBody
            commands={commands}
            groups={groups}
            placeholder={placeholder}
            idleGroupLimit={idleGroupLimit}
            searchGroupLimit={searchGroupLimit}
            close={() => {
              setOpen(false);
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
