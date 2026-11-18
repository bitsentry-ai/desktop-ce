/**
 * The selected-item marker shared by sidebar rows and step cards: a straight 2px brand bar inset from the item's
 * left edge, drawn as its own element so it stays straight instead of bending around the rounded corners.
 */
export const SELECTION_BAR_CLASS =
  "relative before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-[hsl(var(--brand-emphasis))] before:content-['']";
