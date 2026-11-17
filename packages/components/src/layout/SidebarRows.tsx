import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, X } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * Sidebar rows shared by the Dashboard and Desktop navigation. Modelled on
 * T3 Code's thread list: one calm row per item, the live state on the row
 * itself ("Running" with a spinner), and a single muted "View all" link.
 */

export type SidebarRunState = "running" | "queued" | "needs-input" | "failed" | "done" | "completed" | "cancelled" | "idle";

export function SidebarStatusGlyph({ state, label }: { state: SidebarRunState; label: string }) {
  const base = "inline-flex size-3.5 shrink-0 items-center justify-center";
  switch (state) {
    case "running":
      return (
        <span role="img" aria-label={label} className={base}>
          <span className="size-3 animate-spin rounded-full border-[1.5px] border-[hsl(var(--brand-emphasis)/0.25)] border-t-[hsl(var(--brand-emphasis))]" />
        </span>
      );
    case "queued":
      return (
        <span role="img" aria-label={label} className={base}>
          <span className="size-2.5 rounded-full border-[1.5px] border-dashed border-[hsl(var(--brand-emphasis))]" />
        </span>
      );
    case "needs-input":
      return (
        <span role="img" aria-label={label} className={base}>
          <span className="size-2 rounded-full bg-[hsl(var(--warning))] shadow-[0_0_0_3px_hsl(var(--warning)/0.18)]" />
        </span>
      );
    case "done":
      return (
        <span role="img" aria-label={label} className={cn(base, "text-[hsl(var(--success-text))]")}>
          <Check size={12} strokeWidth={2.75} />
        </span>
      );
    case "failed":
      return (
        <span role="img" aria-label={label} className={cn(base, "rounded-full bg-[hsl(var(--destructive)/0.14)] text-[hsl(var(--destructive-text))]")}>
          <X size={9} strokeWidth={3} />
        </span>
      );
    case "completed":
      return (
        <span role="img" aria-label={label} className={cn(base, "text-muted-foreground/80")}>
          <Check size={12} strokeWidth={2.5} />
        </span>
      );
    case "cancelled":
      return (
        <span role="img" aria-label={label} className={base}>
          <span className="h-[1.5px] w-2 rounded-full bg-muted-foreground/60" />
        </span>
      );
    case "idle":
      return (
        <span role="img" aria-label={label} className={base}>
          <span className="size-2 rounded-full border-[1.5px] border-muted-foreground/50" />
        </span>
      );
  }
}

const RUN_STATUS_TEXT: Partial<Record<SidebarRunState, string>> = {
  running: "text-[hsl(var(--brand-emphasis))]",
  queued: "text-[hsl(var(--brand-emphasis))]",
  "needs-input": "text-[hsl(var(--warning-text))]",
  failed: "text-[hsl(var(--destructive-text))]",
  done: "text-[hsl(var(--success-text))]",
};

/** States worth showing on a row; the rest show the row's age instead. */
export function isNotableRunState(state: SidebarRunState): boolean {
  return RUN_STATUS_TEXT[state] !== undefined;
}

/** Live state for the right edge of a row, for example a spinner and "Running". */
export function SidebarRunStatus({ state, label }: { state: SidebarRunState; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-medium", RUN_STATUS_TEXT[state] ?? "text-muted-foreground")}>
      <SidebarStatusGlyph state={state} label={label} />
      <span aria-hidden="true">{label}</span>
    </span>
  );
}

const STATUS_DOT: Partial<Record<SidebarRunState, string>> = {
  completed: "bg-[hsl(var(--success))]",
  done: "bg-[hsl(var(--success))]",
  failed: "bg-[hsl(var(--destructive))]",
  running: "bg-[hsl(var(--brand-emphasis))] motion-safe:animate-pulse",
  queued: "bg-[hsl(var(--brand-emphasis))]",
  "needs-input": "bg-[hsl(var(--warning))]",
};

/** A small leading dot for a row's last known state, so finished rows still read at a glance. */
export function SidebarStatusDot({ state, label }: { state: SidebarRunState; label: string }) {
  return (
    <span role="img" aria-label={label} className="inline-flex size-3.5 shrink-0 items-center justify-center">
      <span className={cn("size-1.5 rounded-full", STATUS_DOT[state] ?? "bg-muted-foreground/50")} />
    </span>
  );
}

export function SidebarGroupLabel({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <div className="flex h-6 items-center gap-1.5 px-2.5 pt-1 text-[11px] font-medium text-muted-foreground">
      <span className="truncate">{children}</span>
      {count !== undefined && <span className="tabular-nums text-muted-foreground">{count}</span>}
      {action !== undefined && <span className="ml-auto flex items-center">{action}</span>}
    </div>
  );
}

export function SidebarRow({
  to,
  title,
  active,
  leading,
  trailing,
  meta,
  hoverAction,
  live,
}: {
  to: string;
  title: string;
  active: boolean;
  /** Status glyph or icon before the title. */
  leading?: ReactNode;
  /** Right side: time, count or live state. Hidden while the hover action shows. */
  trailing?: ReactNode;
  /** Optional second line, kept short. */
  meta?: ReactNode;
  hoverAction?: ReactNode;
  /** Set when `trailing` is a status chip that carries its own color. */
  live?: boolean;
}) {
  return (
    <div className="group/row relative">
      <Link
        to={to}
        title={title}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-8 items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] leading-5 text-muted-foreground transition-colors",
          "hover:bg-[hsl(var(--accent)/0.7)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          active && "bg-accent text-foreground",
        )}
      >
        {leading}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", active ? "font-medium" : "text-foreground/85")}>{title}</span>
          {meta !== undefined && <span className="block truncate text-[11px] leading-4 text-muted-foreground">{meta}</span>}
        </span>
        {trailing !== undefined && (
          <span
            className={cn(
              "shrink-0 text-[11px] tabular-nums",
              live ? "" : "text-muted-foreground/80",
              hoverAction !== undefined && "group-hover/row:invisible group-focus-within/row:invisible",
            )}
          >
            {trailing}
          </span>
        )}
      </Link>
      {hoverAction !== undefined && (
        <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 group-focus-within/row:flex group-hover/row:flex">
          {hoverAction}
        </span>
      )}
    </div>
  );
}

export function SidebarHoverButton({ label, onClick, children, tone = "neutral" }: { label: string; onClick: () => void; children: ReactNode; tone?: "neutral" | "danger" }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        tone === "danger" ? "hover:bg-[hsl(var(--destructive)/0.1)] hover:text-[hsl(var(--destructive-text))]" : "hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function SidebarMoreLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      className="group/more flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-[hsl(var(--accent)/0.7)] hover:text-foreground"
    >
      <span>{label}</span>
      <ArrowRight size={12} className="transition-transform group-hover/more:translate-x-0.5" />
    </Link>
  );
}

export function SidebarEmpty({ children }: { children: ReactNode }) {
  return <p className="px-2.5 py-1.5 text-[12px] text-muted-foreground">{children}</p>;
}

/** Indented container for a section's rows under its nav item. */
export function SidebarSection({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <div id={id} className="bs-sidebar-section mb-1 ml-3 mt-0.5 space-y-px border-l border-border pl-1.5">
      {children}
    </div>
  );
}

const SHORT_UNITS: ReadonlyArray<readonly ["minute" | "hour" | "day" | "week", number]> = [
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/**
 * Compact age for sidebar rows, for example "4h" or "3d" ("4 h" in French).
 * Under a minute reads as `nowLabel`; past eight weeks it shows a short date.
 */
export function shortAge(value: string | number | Date, locale: string | undefined, nowMs: number, nowLabel: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const ageSec = Math.max(0, Math.round((nowMs - date.getTime()) / 1000));
  if (!Number.isFinite(ageSec)) return "";
  if (ageSec < 60) return nowLabel;
  if (ageSec >= 8 * 604_800) return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
  for (const [unit, seconds] of SHORT_UNITS) {
    if (ageSec >= seconds) {
      return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "narrow" }).format(Math.floor(ageSec / seconds));
    }
  }
  return nowLabel;
}
