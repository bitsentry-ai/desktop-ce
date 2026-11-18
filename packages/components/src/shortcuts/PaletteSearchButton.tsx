import { Search } from "lucide-react";
import { useTranslation } from "@bitsentry-ce/i18n";
import { cn } from "../lib/utils";
import { useCommandPalette } from "./CommandPaletteContext";
import { Kbd } from "./Kbd";

/** Sidebar entry point to the command palette, with its ⌘K hint. Hidden when no palette is mounted. */
export function PaletteSearchButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const palette = useCommandPalette();
  if (!palette.available) return null;
  return (
    <button
      type="button"
      onClick={palette.openPalette}
      title={t("common.shortcuts.searchButton")}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] text-muted-foreground",
        "shadow-[0_1px_0_hsl(var(--shadow-color)/0.04)] transition-colors hover:border-border-hover hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
    >
      <Search size={14} className="shrink-0" />
      <span className="bs-sidebar-label flex-1 truncate text-left">{t("common.shortcuts.searchButton")}</span>
      <Kbd keys={["mod", "k"]} className="bs-sidebar-label" />
    </button>
  );
}
