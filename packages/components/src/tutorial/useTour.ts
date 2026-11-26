import { useCallback } from "react";
import type { Config, DriveStep, Driver } from "driver.js";
import { useTranslation } from "@bitsentry-ce/i18n";
import type { TourDefinition, TourId } from "./tour-definitions";

const STORAGE_KEY = "bitsentry_completed_tours";
/** Fired on window whenever a tour is marked done or reset, so open Help sections can update. */
const TOUR_PROGRESS_EVENT = "bitsentry:tour-progress";
/** Tour ids are short identifiers; anything else in storage is ignored. */
const STORED_TOUR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function isStoredTourId(value: unknown): value is string {
  return typeof value === "string" && STORED_TOUR_ID.test(value);
}

function readStoredProgress(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** The finished tour ids in a stored progress string (see {@link getTourProgressSnapshot}). */
export function completedTourIds(progress: string): Set<string> {
  if (progress === "") {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(progress);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(parsed.filter(isStoredTourId));
  } catch {
    return new Set();
  }
}

function getCompletedTours(): Set<string> {
  return completedTourIds(readStoredProgress());
}

function writeCompletedTours(completed: Set<string>) {
  try {
    if (completed.size === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...completed]));
    }
  } catch {
    // Storage can be unavailable (private mode); tours then simply replay.
  }
  window.dispatchEvent(new Event(TOUR_PROGRESS_EVENT));
}

function markTourCompleted(tourId: string) {
  const completed = getCompletedTours();
  completed.add(tourId);
  writeCompletedTours(completed);
}

export function resetTourProgress(tourId?: string) {
  if (tourId === undefined) {
    writeCompletedTours(new Set());
    return;
  }
  const completed = getCompletedTours();
  completed.delete(tourId);
  writeCompletedTours(completed);
}

export function isTourCompleted(tourId: string): boolean {
  return getCompletedTours().has(tourId);
}

/**
 * Subscribes to tour progress for `useSyncExternalStore`: tours finishing in this tab and in other tabs.
 * Pair it with {@link getTourProgressSnapshot}.
 */
export function subscribeToTourProgress(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) onChange();
  };
  window.addEventListener(TOUR_PROGRESS_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TOUR_PROGRESS_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored progress as a string, a stable snapshot for `useSyncExternalStore`. */
export function getTourProgressSnapshot(): string {
  return readStoredProgress();
}

export interface StartTourOpts {
  force?: boolean;
  /** Router navigate — used when the tour needs to change pages. */
  navigate?: (path: string) => void;
}

// ── Module-level state (survives component unmount) ──────────────────────────

let activeTourDriver: Driver | null = null;
let activeTourNavigate: ((path: string) => void) | null = null;
let activeTourRoute: string | null = null;
let activeTourReturnRoute: string | null = null;
/** True while a tour navigates and prepares its page, before its first step shows. */
let startingTour = false;

/** The element a step points at, or null when it points at nothing on this page (a missing target falls back to body). */
function resolveStepTarget(step: DriveStep): Element | null {
  const { element } = step;
  if (element === undefined) return null;
  let resolved: Element | null | undefined;
  if (typeof element === "string") {
    resolved = document.querySelector(element);
  } else if (typeof element === "function") {
    resolved = element();
  } else {
    resolved = element;
  }
  if (resolved === null || resolved === undefined || resolved === document.body || !resolved.isConnected) {
    return null;
  }
  return resolved;
}

function stepTargetPresent(step: DriveStep): boolean {
  return step.element === undefined || resolveStepTarget(step) !== null;
}

const POLL_MS = 100;

async function waitForSelector(selector: string, timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = document.querySelector(selector);
    if (element !== null) return element;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return null;
}

/**
 * A tour `prepare` that opens the first record a link points at (a runbook, a run) unless `readySelector` is already
 * on the page, then waits for it to draw. With nothing to open, the tour runs with the steps that remain.
 */
export function openFirstLinked(
  linkSelector: string,
  readySelector: string,
): NonNullable<TourDefinition["prepare"]> {
  return async (navigate) => {
    if (document.querySelector(readySelector) !== null) return;
    const link = await waitForSelector(linkSelector, 2000);
    if (link === null) return;
    const href = link.getAttribute("href");
    if (href !== null && navigate !== undefined) {
      navigate(href);
    } else if (link instanceof HTMLElement) {
      link.click();
    }
    await waitForSelector(readySelector, 3000);
  };
}

/**
 * A tour `prepare` that waits for the page's data to draw (any element matching `selector`, such as a list or its empty
 * state), so steps that point into data that loads late are not dropped as missing.
 */
export function waitForElement(selector: string, timeoutMs = 6000): NonNullable<TourDefinition["prepare"]> {
  return async () => {
    await waitForSelector(selector, timeoutMs);
  };
}

/**
 * Waits until the page has drawn the tour's targets: every target is present, or the first one is and no new one
 * has appeared for a short while (data still loading adds rows late), or the time runs out.
 */
async function waitForTargets(steps: DriveStep[], timeoutMs: number): Promise<void> {
  const targeted = steps.filter((step) => step.element !== undefined);
  if (targeted.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return;
  }
  const settleMs = 600;
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = targeted.filter((step) => resolveStepTarget(step) !== null).length;
    if (count === targeted.length) return;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (count > 0 && Date.now() - stableSince >= settleMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Runs a tour: navigates to its route, lets it prepare the page, then drives its steps. Steps whose targets are not
 * on the page are left out when the tour asks for it, and a tour left with no steps does not start.
 */
export async function startTourDefinition(tourDef: TourDefinition, opts?: StartTourOpts): Promise<void> {
  // An automatic start never interrupts a tour that is running or that the person just opened from Help.
  if (opts?.force !== true && (isTourCompleted(tourDef.id) || activeTourDriver !== null || startingTour)) return;
  startingTour = true;
  try {

    // Tear down any previous tour
    activeTourDriver?.destroy();

    // Capture navigate + route for post-tour navigation
    activeTourNavigate = opts?.navigate ?? null;
    activeTourRoute = tourDef.route ?? null;
    activeTourReturnRoute = tourDef.returnRoute ?? null;

    // 1. Navigate to the tour's page
    if (tourDef.route !== undefined && opts?.navigate !== undefined) {
      opts.navigate(tourDef.route);
    }

    // 2. Let the tour open what its steps point at, then wait for the page to draw them (max 3 s).
    if (tourDef.prepare !== undefined) {
      await tourDef.prepare(opts?.navigate);
    }
    await waitForTargets(tourDef.steps, 3000);

    const steps = tourDef.skipMissingTargets === true ? tourDef.steps.filter(stepTargetPresent) : tourDef.steps;
    if (steps.length === 0) return;

    const tourId = tourDef.id;
    // Set when the person clicks Done on the last step; closing the tour earlier does not count as finishing it.
    let finished = false;
    // 3. Create driver and start the tour
    const config: Config = {
      showProgress: true,
      animate: true,
      // A neutral dark scrim in both themes: it dims the page around the step without washing it out.
      overlayColor: "rgb(15 23 42)",
      overlayOpacity: 0.42,
      stagePadding: 6,
      stageRadius: 8,
      popoverClass: "bitsentry-tour-popover",
      steps,
      onNextClick: (_element, _step, { driver: instance }) => {
        if (!instance.hasNextStep()) finished = true;
        instance.moveNext();
      },
      onDestroyed: () => {
        if (finished) markTourCompleted(tourId);
        // Leave a preview page (/tour/*) for the real page; tours over real pages stay where the person is.
        if (activeTourNavigate !== null && activeTourRoute !== null) {
          if (activeTourReturnRoute !== null) {
            activeTourNavigate(activeTourReturnRoute);
          } else if (activeTourRoute.startsWith("/tour/")) {
            activeTourNavigate(activeTourRoute.replace(/^\/tour\//, "/"));
          }
        }
        activeTourDriver = null;
        activeTourNavigate = null;
        activeTourRoute = null;
        activeTourReturnRoute = null;
      },
    };

    // Loaded here so the tour library stays out of the startup bundle.
    const { driver } = await import("driver.js");
    const instance = driver(config);
    activeTourDriver = instance;
    instance.drive();
  } catch (err) {
    console.error(`[tour:${tourDef.id}] start() failed:`, err);
  } finally {
    startingTour = false;
  }
}

type Translate = ReturnType<typeof useTranslation>["t"];

// Kept outside the hook so the React Compiler can compile useTour: it cannot lower the dynamic import() calls.
async function startTour(tourId: TourId, t: Translate, opts?: StartTourOpts) {
  try {
    // Loaded on start, like driver.js, to keep tours out of the startup bundle.
    const { getTours } = await import("./tour-definitions");
    const tourDef = getTours(t)[tourId];
    if (tourDef === undefined) return;
    await startTourDefinition(tourDef, opts);
  } catch (err) {
    console.error(`[tour:${tourId}] start() failed:`, err);
  }
}

export function useTour(tourId: TourId = "main") {
  const { t } = useTranslation();
  const start = useCallback(
    (opts?: StartTourOpts) => startTour(tourId, t, opts),
    [t, tourId],
  );

  return { start };
}
