import {
  Fragment,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "@bitsentry-ce/i18n";

import { cn } from "../lib/utils";
import {
  RESULTS_COLUMN_MIN_PERCENT,
  type ResultsColumnDivider,
  type ResultsColumnSplit,
} from "./resultsColumnSplit";
import {
  useResultsColumnSplit,
  type ResultsColumnDividerHandlers,
} from "./useResultsColumnSplit";

export type ResultsPanelId = "summary" | "steps" | "output";

const PANEL_IDS: readonly ResultsPanelId[] = ["summary", "steps", "output"];

const PANEL_LABEL_KEYS: Record<ResultsPanelId, string> = {
  summary: "common.results.summary",
  steps: "common.results.steps",
  output: "common.results.output",
};

// Column widths at lg+, where all three panels sit side by side. The widths
// come from the split as CSS variables so they only apply at that breakpoint.
const PANEL_WIDTH_CLASS: Record<ResultsPanelId, string> = {
  summary: "lg:flex-[0_1_var(--results-col-summary)]",
  steps: "lg:flex-[0_1_var(--results-col-steps)]",
  output: "lg:flex-[0_1_var(--results-col-output)]",
};

function splitStyle(split: ResultsColumnSplit): CSSProperties {
  return {
    "--results-col-summary": `${String(split[0])}%`,
    "--results-col-steps": `${String(split[1])}%`,
    "--results-col-output": `${String(split[2])}%`,
  } as CSSProperties;
}

/**
 * A 1px rule between two columns with a wider invisible grip, draggable and
 * movable with the arrow keys (Home / End jump to the limits, double-click
 * resets). Hidden below lg, where the panels are tabs.
 */
function ColumnDivider({
  divider,
  split,
  label,
  controls,
  dragging,
  handlers,
}: {
  divider: ResultsColumnDivider;
  split: ResultsColumnSplit;
  label: string;
  controls: string;
  dragging: boolean;
  handlers: ResultsColumnDividerHandlers;
}) {
  const before = split[divider];
  const pair = before + split[divider + 1];
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(before)}
      aria-valuemin={RESULTS_COLUMN_MIN_PERCENT}
      aria-valuemax={Math.round(pair - RESULTS_COLUMN_MIN_PERCENT)}
      tabIndex={0}
      data-dragging={dragging}
      {...handlers}
      className={cn(
        "relative z-10 hidden w-px shrink-0 cursor-col-resize touch-none select-none bg-border outline-none transition-colors lg:block",
        "before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-['']",
        "hover:bg-primary/50 focus-visible:bg-primary focus-visible:before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring/40 data-[dragging=true]:bg-primary",
      )}
    />
  );
}

function nextPanelForKey(
  key: string,
  current: ResultsPanelId,
): ResultsPanelId | null {
  const index = PANEL_IDS.indexOf(current);
  switch (key) {
    case "ArrowRight":
      return PANEL_IDS[(index + 1) % PANEL_IDS.length];
    case "ArrowLeft":
      return PANEL_IDS[(index + PANEL_IDS.length - 1) % PANEL_IDS.length];
    case "Home":
      return PANEL_IDS[0];
    case "End":
      return PANEL_IDS[PANEL_IDS.length - 1];
    default:
      return null;
  }
}

/**
 * The Summary / Steps / Output body of a run result.
 *
 * At lg+ the three panels sit side by side in resizable columns (Summary and
 * Steps narrow, Output wide). Below lg they would stack, and a long output
 * would bury the steps under it, so a tab bar pinned above the scroll area
 * shows one panel at a time instead.
 */
export function ResultsDetailPanels({
  activePanel,
  onActivePanelChange,
  summary,
  steps,
  output,
}: {
  activePanel: ResultsPanelId;
  onActivePanelChange: (panel: ResultsPanelId) => void;
  summary: ReactNode;
  steps: ReactNode;
  output: ReactNode;
}) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const tabRefs = useRef<
    Partial<Record<ResultsPanelId, HTMLButtonElement | null>>
  >({});
  const columnsRef = useRef<HTMLDivElement>(null);
  const { split, draggingDivider, dividerHandlers } =
    useResultsColumnSplit(columnsRef);
  const content: Record<ResultsPanelId, ReactNode> = { summary, steps, output };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextPanelForKey(event.key, activePanel);
    if (next === null) return;
    event.preventDefault();
    onActivePanelChange(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-4 py-2 lg:hidden">
        <div
          role="tablist"
          aria-label={t("common.results.sectionsLabel")}
          onKeyDown={handleKeyDown}
          className="grid h-8 grid-cols-3 rounded-md bg-muted p-0.5"
        >
          {PANEL_IDS.map((panel) => {
            const selected = panel === activePanel;
            return (
              <button
                key={panel}
                ref={(node) => {
                  tabRefs.current[panel] = node;
                }}
                type="button"
                role="tab"
                id={`${idPrefix}-tab-${panel}`}
                aria-selected={selected}
                aria-controls={`${idPrefix}-panel-${panel}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  onActivePanelChange(panel);
                }}
                className={cn(
                  "rounded-[5px] text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  selected
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(PANEL_LABEL_KEYS[panel])}
              </button>
            );
          })}
        </div>
      </div>
      <div
        ref={columnsRef}
        style={splitStyle(split)}
        className={cn(
          "flex min-h-0 flex-1 flex-col lg:flex-row",
          draggingDivider !== null && "cursor-col-resize select-none",
        )}
      >
        {PANEL_IDS.map((panel, index) => {
          const divider =
            index < PANEL_IDS.length - 1
              ? (index as ResultsColumnDivider)
              : null;
          return (
            <Fragment key={panel}>
              <div
                role="tabpanel"
                id={`${idPrefix}-panel-${panel}`}
                aria-labelledby={`${idPrefix}-tab-${panel}`}
                className={cn(
                  "min-h-0 min-w-0 flex-1 overflow-hidden lg:block",
                  PANEL_WIDTH_CLASS[panel],
                  panel === activePanel ? "block" : "hidden",
                )}
              >
                {content[panel]}
              </div>
              {divider !== null && (
                <ColumnDivider
                  divider={divider}
                  split={split}
                  label={t("common.results.resizeColumns", {
                    before: t(PANEL_LABEL_KEYS[panel]),
                    after: t(PANEL_LABEL_KEYS[PANEL_IDS[index + 1]]),
                  })}
                  controls={`${idPrefix}-panel-${panel}`}
                  dragging={draggingDivider === divider}
                  handlers={dividerHandlers(divider)}
                />
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Column header for a results panel. Below lg the tab bar already names the
 * panel, so the header only shows alongside the other columns.
 */
export function ResultsPanelHeader({ children }: { children: ReactNode }) {
  return (
    <div className="hidden shrink-0 border-b border-border px-4 py-3 lg:block">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {children}
      </h3>
    </div>
  );
}
