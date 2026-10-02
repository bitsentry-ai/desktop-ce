import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, Check, ChevronDown, Search } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { RunbookRecord } from "../services/contracts";
import { cn } from "../lib/utils";
import { Input } from "../ui/input";

type PickerRunbook = Pick<RunbookRecord, "id" | "title" | "revisionNumber">;

const SHORT_ID_LENGTH = 8;
const shortId = (id: string) => (id.length > SHORT_ID_LENGTH + 2 ? `${id.slice(0, SHORT_ID_LENGTH)}…` : id);

/** Titles that match the search come first; a runbook that only matches by ID follows. The catalog order is kept otherwise. */
function filterRunbooks<T extends PickerRunbook>(runbooks: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return runbooks;
  const byTitle = runbooks.filter((row) => row.title.toLowerCase().includes(needle));
  const byIdOnly = runbooks.filter((row) => !row.title.toLowerCase().includes(needle) && row.id.toLowerCase().includes(needle));
  return [...byTitle, ...byIdOnly];
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  const start = needle === "" ? -1 : text.toLowerCase().indexOf(needle);
  if (start < 0) return <>{text}</>;
  const end = start + needle.length;
  return <Fragment>{text.slice(0, start)}<mark className="rounded-sm bg-primary/15 px-0.5 text-foreground">{text.slice(start, end)}</mark>{text.slice(end)}</Fragment>;
}

/** Revision and ID as quiet context. The ID is cut for scanning; its full value is in the tooltip and read out by screen readers. */
function RunbookContext({ runbook }: { runbook: PickerRunbook }) {
  const { t } = useTranslation();
  return <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
    <span className="shrink-0">{t("incidents.knowledge.revision", { revision: runbook.revisionNumber })}</span>
    <span aria-hidden="true">·</span>
    <span aria-hidden="true" className="min-w-0 truncate font-mono" title={runbook.id}>{t("incidents.knowledge.picker.id", { id: shortId(runbook.id) })}</span>
    <span className="sr-only">{t("incidents.knowledge.picker.id", { id: runbook.id })}</span>
  </span>;
}

/**
 * An inline searchable chooser for a saved runbook. It opens in the flow of the rail, never over the chat, keeps its
 * results to a bounded scroll area, and only reports the choice: reviewing and running stay with the caller.
 */
export function RunbookPicker({ runbooks, selectedId, loading, loadFailed, disabled, onSelect }: {
  runbooks: PickerRunbook[];
  selectedId: string | null;
  loading: boolean;
  loadFailed: boolean;
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const { t } = useTranslation();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-option-${id}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const selected = runbooks.find((row) => row.id === selectedId) ?? null;
  const results = useMemo(() => filterRunbooks(runbooks, query), [runbooks, query]);
  // The highlighted row follows its runbook through a refresh of the catalog; it falls back to the first result.
  const active = results.find((row) => row.id === activeId) ?? results[0] ?? null;

  // A running request locks the chooser; it must not stay open over a control that can no longer be used.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  function openPicker() {
    setQuery("");
    setActiveId(selected?.id ?? null);
    setOpen(true);
  }
  function closePicker(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }
  function choose(id: string) {
    onSelect(id);
    closePicker(true);
  }
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    containerRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  useEffect(() => {
    if (!open || active === null) return;
    document.getElementById(optionId(active.id))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `optionId` only derives from `baseId`.
  }, [active?.id, open]);

  function move(step: number | "first" | "last") {
    if (results.length === 0) return;
    const current = active === null ? 0 : results.findIndex((row) => row.id === active.id);
    let next = current + (typeof step === "number" ? step : 0);
    if (step === "first") next = 0;
    if (step === "last") next = results.length - 1;
    setActiveId(results[Math.min(Math.max(next, 0), results.length - 1)]!.id);
  }
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const moves: Record<string, number | "first" | "last"> = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" };
    const step = moves[event.key];
    if (step !== undefined) {
      event.preventDefault();
      move(step);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active !== null) choose(active.id);
      return;
    }
    // Escape only closes the chooser. The rail also closes on Escape unless the key was handled here.
    if (event.key === "Escape") {
      event.preventDefault();
      closePicker(true);
    }
  }

  const empty = !loading && !loadFailed && runbooks.length === 0;
  const noMatch = !loading && runbooks.length > 0 && results.length === 0;
  return <div ref={containerRef} className="space-y-2" onBlur={(event) => { if (open && !containerRef.current?.contains(event.relatedTarget)) closePicker(false); }}>
    <button ref={triggerRef} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled}
      onClick={() => { if (open) closePicker(false); else openPicker(); }}
      className={cn("flex w-full items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        open ? "border-primary" : "border-border hover:border-primary/40")}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background"><BookOpen size={15} className="text-muted-foreground" aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {selected === null
          ? <>
            <span className="text-sm font-medium">{t("incidents.knowledge.picker.placeholder")}</span>
            <span className="text-xs text-muted-foreground">{t("incidents.knowledge.picker.hint")}</span>
          </>
          : <>
            <span className="line-clamp-2 break-words text-sm font-medium" title={selected.title}>{selected.title}</span>
            <RunbookContext runbook={selected} />
          </>}
      </span>
      <ChevronDown size={16} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden="true" />
    </button>
    {open && <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3 focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/40">
        <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input ref={searchRef} role="combobox" aria-label={t("incidents.knowledge.picker.searchLabel")} aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={active === null ? undefined : optionId(active.id)} autoComplete="off" spellCheck={false}
          placeholder={t("incidents.knowledge.picker.searchPlaceholder")} value={query}
          onChange={(event) => { setQuery(event.target.value); }} onKeyDown={handleSearchKeyDown}
          className="h-10 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" />
      </div>
      {/* Pressing a row must not move focus off the search field, or the blur would close the list before the click lands. */}
      <ul id={listId} role="listbox" aria-label={t("incidents.knowledge.runbook")} onMouseDown={(event) => { event.preventDefault(); }}
        className="max-h-[min(16rem,40vh)] overflow-y-auto overscroll-contain p-1">
        {results.map((row) => {
          const isSelected = row.id === selected?.id;
          const isActive = row.id === active?.id;
          return <li key={row.id} id={optionId(row.id)} role="option" aria-selected={isSelected} onClick={() => { choose(row.id); }} onMouseMove={() => { if (!isActive) setActiveId(row.id); }}
            className={cn("flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2", isActive && "bg-muted", isSelected && "bg-primary/5")}>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-primary">{isSelected && <Check size={14} aria-hidden="true" />}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="line-clamp-2 break-words text-sm font-medium" title={row.title}><Highlight text={row.title} query={query} /></span>
              <RunbookContext runbook={row} />
            </span>
          </li>;
        })}
        {loading && <li role="presentation" className="px-3 py-4 text-sm text-muted-foreground">{t("incidents.knowledge.picker.loading")}</li>}
        {empty && <li role="presentation" className="px-3 py-4 text-sm text-muted-foreground">{t("incidents.knowledge.picker.empty")}</li>}
        {noMatch && <li role="presentation" className="px-3 py-4 text-sm text-muted-foreground">{t("incidents.knowledge.picker.noMatch", { query: query.trim() })}</li>}
      </ul>
      <p role="status" className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        {runbooks.length > 0 && t("incidents.knowledge.picker.count", { shown: results.length, total: runbooks.length })}
      </p>
    </div>}
  </div>;
}
