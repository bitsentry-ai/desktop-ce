// Icon-only secondary buttons on runbook screens: 32px squares on pointer
// screens and 44px touch targets below the sm breakpoint.
export const RUNBOOK_ICON_BUTTON_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:size-11";

// "Add action" buttons: a normal-contrast outline so they read as actions
// rather than disabled helper text.
export const RUNBOOK_ADD_ACTION_BUTTON_CLASS =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-11";
