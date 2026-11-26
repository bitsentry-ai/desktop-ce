import React, { useSyncExternalStore } from "react";
import { Check, Play, RotateCcw } from "lucide-react";
import { getTours, type TourDefinition, type TourId } from "./tour-definitions";
import {
  completedTourIds,
  getTourProgressSnapshot,
  resetTourProgress,
  startTourDefinition,
  subscribeToTourProgress,
} from "./useTour";
import { useTranslation } from "@bitsentry-ce/i18n";

/** A titled set of tours in the Help section, for example "Getting started". */
export interface HelpTourGroup {
  id: string;
  title: string;
  tours: readonly TourDefinition[];
}

interface TourRowProps {
  tour: TourDefinition;
  completed: boolean;
  navigate?: (path: string) => void;
}

const TourRow: React.FC<TourRowProps> = ({ tour, completed, navigate }) => {
  const { t } = useTranslation();

  const handleClick = () => {
    if (completed) {
      resetTourProgress(tour.id);
    }
    void startTourDefinition(tour, { force: true, navigate });
  };

  const actionLabel = completed ? t("common.helpSection.replay") : t("common.helpSection.start");

  return (
    <li className="flex min-h-12 items-center gap-4 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <p className="text-sm font-medium text-foreground">{tour.label}</p>
          {completed && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[hsl(var(--success-text))]">
              <Check size={12} aria-hidden="true" />
              {t("common.helpSection.done")}
            </span>
          )}
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{tour.description}</p>
      </div>

      <button
        type="button"
        onClick={handleClick}
        aria-label={`${actionLabel}: ${tour.label}`}
        className="inline-flex h-9 w-24 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-sm:h-11 [@media(pointer:coarse)]:h-11"
      >
        {completed ? <RotateCcw size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
        {actionLabel}
      </button>
    </li>
  );
};

interface HelpSectionProps {
  /** Router navigate function — needed for page-specific tours. */
  navigate?: (path: string) => void;
  /** Desktop tours to leave out of the default groups. Ignored when `groups` is given. */
  excludedTourIds?: TourId[];
  /** The tours to list, grouped. Defaults to the Desktop tours. */
  groups?: readonly HelpTourGroup[];
}

// Display order is decoupled from the tours record so reordering these lists
// doesn't require touching tour-definitions, and adding a new tour doesn't
// silently slot it in wherever Object.keys happens to put it.
const GETTING_STARTED: readonly TourId[] = ["main", "settings"];
const INVESTIGATE_TOURS: readonly TourId[] = ["incidents", "results"];
const AUTOMATE_TOURS: readonly TourId[] = ["runbooks", "runbookCreation", "dataSources"];

function useDesktopTourGroups(excludedTourIds: readonly TourId[]): HelpTourGroup[] {
  const { t } = useTranslation();
  const tours = getTours(t);
  const excluded = new Set(excludedTourIds);
  const pick = (ids: readonly TourId[]) => ids.filter((id) => !excluded.has(id)).map((id) => tours[id]);
  return [
    { id: "getting-started", title: t("common.helpSection.gettingStarted"), tours: pick(GETTING_STARTED) },
    { id: "investigate", title: t("common.helpSection.investigate"), tours: pick(INVESTIGATE_TOURS) },
    { id: "automate", title: t("common.helpSection.automate"), tours: pick(AUTOMATE_TOURS) },
  ];
}

const NO_EXCLUDED_TOURS: TourId[] = [];

export const HelpSection: React.FC<HelpSectionProps> = ({
  navigate,
  excludedTourIds = NO_EXCLUDED_TOURS,
  groups,
}) => {
  // Completion is read from the progress snapshot, so the rows update when a tour finishes or is reset, here or in
  // another tab.
  const progress = useSyncExternalStore(subscribeToTourProgress, getTourProgressSnapshot, () => "");
  const completedIds = completedTourIds(progress);
  const desktopGroups = useDesktopTourGroups(excludedTourIds);
  const visibleGroups = (groups ?? desktopGroups).filter((group) => group.tours.length > 0);

  return (
    <div className="space-y-4">
      {visibleGroups.map((group) => {
        const headingId = `help-tours-${group.id}`;
        return (
          <section key={group.id} aria-labelledby={headingId}>
            <h3 id={headingId} className="mb-1.5 text-xs font-medium text-muted-foreground">
              {group.title}
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {group.tours.map((tour) => (
                <TourRow
                  key={tour.id}
                  tour={tour}
                  completed={completedIds.has(tour.id)}
                  navigate={navigate}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
};
