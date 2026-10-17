import { useCallback } from "react";
import { driver, type Config } from "driver.js";
import { useTranslation } from "@bitsentry-ce/i18n";
import { getTours, type TourId } from "./tour-definitions";

const STORAGE_KEY = "bitsentry_completed_tours";
const TOUR_IDS = new Set<string>([
  "main",
  "dashboard",
  "incidents",
  "runbooks",
  "results",
  "settings",
  "runbookCreation",
  "dataSources",
]);

function isTourId(value: unknown): value is TourId {
  return typeof value === "string" && TOUR_IDS.has(value);
}

function getCompletedTours(): Set<TourId> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return new Set();
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter(isTourId));
  } catch {
    return new Set();
  }
}

function markTourCompleted(tourId: TourId) {
  const completed = getCompletedTours();
  completed.add(tourId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...completed]));
}

export function resetTourProgress(tourId?: TourId) {
  if (tourId !== undefined) {
    const completed = getCompletedTours();
    completed.delete(tourId);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...completed]));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function isTourCompleted(tourId: TourId): boolean {
  return getCompletedTours().has(tourId);
}

export interface StartTourOpts {
  force?: boolean;
  /** Router navigate — used when the tour needs to change pages. */
  navigate?: (path: string) => void;
}

// ── Module-level state (survives component unmount) ──────────────────────────

let activeTourDriver: ReturnType<typeof driver> | null = null;
let activeTourNavigate: ((path: string) => void) | null = null;
let activeTourRoute: string | null = null;
let activeTourReturnRoute: string | null = null;

async function waitForElement(
  resolve: () => Element | null,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = resolve();
    if (el !== null && el !== document.body) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export function useTour(tourId: TourId = "main") {
  const { t } = useTranslation();
  const start = useCallback(
    async (opts?: StartTourOpts) => {
      try {
        const tours = getTours(t);
        const tourDef = tours[tourId];
        if (tourDef === undefined) return;

        if (opts?.force !== true && isTourCompleted(tourId)) return;

        // Tear down any previous tour
        activeTourDriver?.destroy();

        // Capture navigate + route for post-tour navigation
        activeTourNavigate = opts?.navigate ?? null;
        activeTourRoute = tourDef.route ?? null;
        activeTourReturnRoute = tourDef.returnRoute ?? null;

        // 1. Navigate to the preview page
        if (tourDef.route !== undefined && opts?.navigate !== undefined) {
          opts.navigate(tourDef.route);

          // Poll until the first real tour-target element appears (max 3 s).
          const firstTargeted = tourDef.steps.find((s) => s.element);
          if (firstTargeted !== undefined) {
            const resolveEl = () => {
              if (typeof firstTargeted.element === "function") {
                const el = firstTargeted.element();
                if (el !== null && el !== document.body) {
                  return el;
                }

                return null;
              }
              if (typeof firstTargeted.element === "string") {
                return document.querySelector(firstTargeted.element);
              }
              return null;
            };

            await waitForElement(resolveEl, 3000);
          } else {
            await new Promise((r) => setTimeout(r, 600));
          }
        }

        // 2. Create driver and start the tour
        const config: Config = {
          showProgress: true,
          animate: true,
          overlayColor: "hsl(var(--background))",
          overlayOpacity: 0.75,
          stagePadding: 6,
          stageRadius: 8,
          popoverClass: "bitsentry-tour-popover",
          steps: tourDef.steps,
          onDestroyed: () => {
            markTourCompleted(tourId);
            // Navigate from preview page (/tour/*) to the real page
            if (activeTourNavigate !== null && activeTourRoute !== null) {
              let realRoute = activeTourRoute.replace(/^\/tour\//, "/");
              if (activeTourReturnRoute !== null) {
                realRoute = activeTourReturnRoute;
              }

              activeTourNavigate(realRoute);
            }
            activeTourDriver = null;
            activeTourNavigate = null;
            activeTourRoute = null;
            activeTourReturnRoute = null;
          },
        };

        const instance = driver(config);
        activeTourDriver = instance;
        instance.drive();
      } catch (err) {
        console.error(`[tour:${tourId}] start() failed:`, err);
      }
    },
    [t, tourId],
  );

  return { start };
}
