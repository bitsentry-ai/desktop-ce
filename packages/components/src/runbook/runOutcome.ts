/**
 * The one-line, human-readable outcome that leads a run's Summary, e.g.
 * "Completed 3 of 3 steps in 0.6 s" or "Failed at step 2 of 3: Check disk".
 *
 * Built only from data the Results view already holds; kept free of React so
 * the wording rules are testable alone.
 */

export type RunOutcomeStatus =
  | "awaiting_approval"
  | "queued"
  | "pending"
  | "running"
  | "claim_expired"
  | "completed"
  | "failed"
  | "cancelled";

export type RunOutcomeTone = "success" | "danger" | "warning" | "neutral";

export interface RunOutcomeStep {
  status: string;
  title: string;
}

export interface RunOutcomeInput {
  status: RunOutcomeStatus;
  /** The execution's steps, or null while only the run summary is known. */
  steps: readonly RunOutcomeStep[] | null;
  completedSteps: number;
  totalSteps: number;
  startedAt: string | undefined;
  completedAt: string | undefined;
}

export interface RunOutcome {
  text: string;
  tone: RunOutcomeTone;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
/** Below this many seconds the duration keeps one decimal ("0.6 s"). */
const FRACTIONAL_SECONDS_LIMIT = 10;

/** Milliseconds between two ISO timestamps, or null when either is missing or invalid. */
export function runDurationMs(
  startedAt: string | undefined,
  completedAt: string | undefined,
): number | null {
  if (startedAt === undefined || completedAt === undefined) return null;
  const elapsed = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

/** "0.6 s", "42 s", "3 min 5 s", "1 h 12 min". */
export function formatRunDuration(ms: number, t: Translate): string {
  const seconds = ms / MS_PER_SECOND;
  if (seconds < FRACTIONAL_SECONDS_LIMIT) {
    return t("common.results.durationSeconds", {
      value: Math.round(seconds * 10) / 10,
    });
  }
  const totalSeconds = Math.round(seconds);
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return t("common.results.durationSeconds", { value: totalSeconds });
  }
  if (totalSeconds < SECONDS_PER_HOUR) {
    return t("common.results.durationMinutes", {
      minutes: Math.floor(totalSeconds / SECONDS_PER_MINUTE),
      seconds: totalSeconds % SECONDS_PER_MINUTE,
    });
  }
  return t("common.results.durationHours", {
    hours: Math.floor(totalSeconds / SECONDS_PER_HOUR),
    minutes: Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
  });
}

function completedOutcome(input: RunOutcomeInput, t: Translate): RunOutcome {
  const counts = { completed: input.completedSteps, count: input.totalSteps };
  const duration = runDurationMs(input.startedAt, input.completedAt);
  const text =
    duration === null
      ? t("common.results.outcomeCompletedSteps", counts)
      : t("common.results.outcomeCompleted", {
          ...counts,
          duration: formatRunDuration(duration, t),
        });
  return { text, tone: "success" };
}

function failedOutcome(input: RunOutcomeInput, t: Translate): RunOutcome {
  const steps = input.steps ?? [];
  const index = steps.findIndex((step) => step.status === "failed");
  if (index === -1) {
    return {
      text: t("common.results.outcomeFailed", {
        completed: input.completedSteps,
        count: input.totalSteps,
      }),
      tone: "danger",
    };
  }

  const position = { position: index + 1, total: steps.length };
  const title = steps[index].title.trim();
  const text =
    title.length > 0
      ? t("common.results.outcomeFailedAt", { ...position, title })
      : t("common.results.outcomeFailedAtUntitled", position);
  return { text, tone: "danger" };
}

const PROGRESS_OUTCOMES: Record<
  "running" | "cancelled" | "claim_expired",
  { key: string; tone: RunOutcomeTone }
> = {
  running: { key: "common.results.outcomeRunning", tone: "neutral" },
  cancelled: { key: "common.results.outcomeCancelled", tone: "warning" },
  claim_expired: { key: "common.results.outcomeInterrupted", tone: "danger" },
};

export function describeRunOutcome(
  input: RunOutcomeInput,
  t: Translate,
): RunOutcome {
  switch (input.status) {
    case "completed":
      return completedOutcome(input, t);
    case "failed":
      return failedOutcome(input, t);
    case "queued":
    case "pending":
      return { text: t("common.results.outcomeWaiting"), tone: "neutral" };
    case "awaiting_approval":
      return { text: t("common.results.statusAwaitingApproval"), tone: "warning" };
    case "running":
    case "cancelled":
    case "claim_expired": {
      const { key, tone } = PROGRESS_OUTCOMES[input.status];
      return {
        text: t(key, {
          completed: input.completedSteps,
          count: input.totalSteps,
        }),
        tone,
      };
    }
  }
}
