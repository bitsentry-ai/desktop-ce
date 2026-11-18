import { SELECTION_BAR_CLASS } from "../lib/selectionBar";
import { cn } from "../lib/utils";

/** Class names for the step cards in the Results Steps column, shared by both apps. */

const STEP_CARD_BASE_CLASS =
  "w-full rounded-lg border border-border px-3 py-2 text-left text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * Selection is a neutral surface with a 2px brand bar on the left, so it never
 * reads as the green of a completed status.
 */
export function resultsStepCardClass(isSelected: boolean): string {
  if (isSelected) {
    return cn(STEP_CARD_BASE_CLASS, "border-[hsl(var(--brand-emphasis-border))] bg-[hsl(var(--selection))]", SELECTION_BAR_CLASS, "before:inset-y-2.5");
  }
  return `${STEP_CARD_BASE_CLASS} bg-muted/10 hover:bg-muted/30`;
}

/** Step titles wrap to two lines before they are cut off. */
export const RESULTS_STEP_TITLE_CLASS =
  "line-clamp-2 min-w-0 break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]";

const STEP_STATUS_TEXT_CLASS: Partial<Record<string, string>> = {
  completed: "text-[hsl(var(--success-text))]",
  failed: "text-destructive",
  running: "text-[hsl(var(--warning-text))]",
};

/** Status colour for a step's status label; success green is kept for "completed". */
export function resultsStepStatusClass(status: string): string {
  return STEP_STATUS_TEXT_CLASS[status] ?? "text-muted-foreground";
}
