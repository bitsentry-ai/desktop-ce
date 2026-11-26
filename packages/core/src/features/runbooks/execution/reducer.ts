import type {
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
} from "../runbooks.schemas";

export interface CompletedStepUpdate {
  completedAt: string;
  output?: RunbookExecutionStepRecord["output"];
  metadata?: RunbookExecutionStepRecord["metadata"];
  structuredOutput?: RunbookExecutionStepRecord["structuredOutput"];
  exitCode?: number;
  statusCode?: number;
}

export interface FailedStepUpdate extends CompletedStepUpdate {
  error: string;
  completionReason: NonNullable<RunbookExecutionRecord["completionReason"]>;
}

const TERMINAL_EXECUTION_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "claim_expired",
]);

export function recordExecutionActivity(
  snapshot: RunbookExecutionRecord,
  timestamp: string,
): void {
  snapshot.lastActivityAt = timestamp;
}

export function bumpExecutionSnapshotVersion(
  snapshot: RunbookExecutionRecord,
): number {
  const nextVersion = nextSnapshotVersion(snapshot.snapshotVersion);
  snapshot.snapshotVersion = nextVersion;
  return nextVersion;
}

function nextSnapshotVersion(currentVersion: unknown): number {
  if (
    typeof currentVersion === "number" &&
    Number.isInteger(currentVersion) &&
    currentVersion >= 0
  ) {
    return currentVersion + 1;
  }

  return 1;
}

export function markExecutionRunning(
  snapshot: RunbookExecutionRecord,
  timestamp: string,
): void {
  snapshot.status = "running";
  recordExecutionActivity(snapshot, timestamp);
}

export function markStepRunning(
  snapshot: RunbookExecutionRecord,
  stepIndex: number,
  startedAt: string,
): RunbookExecutionStepRecord {
  const step = snapshot.steps[stepIndex];
  step.status = "running";
  step.startedAt = startedAt;
  step.output = undefined;
  step.error = undefined;
  step.metadata = undefined;
  step.structuredOutput = undefined;
  step.exitCode = undefined;
  step.statusCode = undefined;
  recordExecutionActivity(snapshot, startedAt);
  return step;
}

export function markStepCompleted(
  snapshot: RunbookExecutionRecord,
  stepIndex: number,
  update: CompletedStepUpdate,
): RunbookExecutionStepRecord {
  const step = snapshot.steps[stepIndex];
  step.status = "completed";
  step.completedAt = update.completedAt;
  step.output = update.output;
  step.error = undefined;
  step.metadata = update.metadata;
  step.structuredOutput = update.structuredOutput;
  step.exitCode = update.exitCode;
  step.statusCode = update.statusCode;
  recordExecutionActivity(snapshot, update.completedAt);
  return step;
}

export function markStepFailed(
  snapshot: RunbookExecutionRecord,
  stepIndex: number,
  update: FailedStepUpdate,
): RunbookExecutionStepRecord {
  const step = snapshot.steps[stepIndex];
  step.status = "failed";
  step.completedAt = update.completedAt;
  step.error = update.error;
  step.output = update.output;
  step.metadata = update.metadata;
  step.structuredOutput = update.structuredOutput;
  step.exitCode = update.exitCode;
  step.statusCode = update.statusCode;
  snapshot.status = "failed";
  snapshot.completedAt = update.completedAt;
  snapshot.completionReason = update.completionReason;
  recordExecutionActivity(snapshot, update.completedAt);
  return step;
}

export function markExecutionCompleted(
  snapshot: RunbookExecutionRecord,
  completedAt: string,
  completionReason: NonNullable<RunbookExecutionRecord["completionReason"]> = "success",
): void {
  snapshot.status = "completed";
  snapshot.completedAt = completedAt;
  snapshot.completionReason = completionReason;
  recordExecutionActivity(snapshot, completedAt);
}

export function isTerminalExecutionStatus(status: string): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}

export function findCurrentExecutionStep(
  snapshot: RunbookExecutionRecord,
  options?: { includePending?: boolean },
): RunbookExecutionStepRecord | undefined {
  const runningStep = snapshot.steps.find((step) => step.status === "running");
  if (runningStep !== undefined) return runningStep;

  const awaitingStep = snapshot.steps.find(
    (step) => step.status === "awaiting_approval",
  );
  if (awaitingStep !== undefined) return awaitingStep;

  if (options?.includePending === true) {
    return snapshot.steps.find((step) => step.status === "pending");
  }

  return undefined;
}

export function findNextExecutableStepIndex(
  snapshot: RunbookExecutionRecord,
): number | null {
  const runningIndex = snapshot.steps.findIndex((step) => step.status === "running");
  if (runningIndex >= 0) {
    return runningIndex;
  }

  const pendingIndex = snapshot.steps.findIndex((step) => step.status === "pending");
  if (pendingIndex >= 0) {
    return pendingIndex;
  }

  return null;
}

export function markExecutionCancelled(
  snapshot: RunbookExecutionRecord,
  input: {
    completedAt: string;
    completionReason: NonNullable<RunbookExecutionRecord["completionReason"]>;
    errorMessage?: string;
    includePendingStep?: boolean;
    preserveCompletedAt?: boolean;
  },
): void {
  const step = findCurrentExecutionStep(snapshot, {
    includePending: input.includePendingStep,
  });

  if (step !== undefined) {
    step.status = "cancelled";
    step.completedAt = input.completedAt;
    step.error = step.error ?? input.errorMessage;
  }

  snapshot.status = "cancelled";
  snapshot.completedAt = cancelledCompletedAt(snapshot, input);
  snapshot.completionReason = input.completionReason;
  recordExecutionActivity(snapshot, input.completedAt);
}

function cancelledCompletedAt(
  snapshot: RunbookExecutionRecord,
  input: { completedAt: string; preserveCompletedAt?: boolean },
): string {
  if (input.preserveCompletedAt === true) {
    return snapshot.completedAt ?? input.completedAt;
  }

  return input.completedAt;
}

export function markExecutionInterrupted(
  snapshot: RunbookExecutionRecord,
  input: {
    completedAt: string;
    completionReason: NonNullable<RunbookExecutionRecord["completionReason"]>;
    errorMessage: string;
    includePendingStep?: boolean;
  },
): void {
  const step = findCurrentExecutionStep(snapshot, {
    includePending: input.includePendingStep,
  });

  if (step !== undefined) {
    step.status = "failed";
    step.completedAt = input.completedAt;
    step.error = step.error ?? input.errorMessage;
    step.startedAt = step.startedAt ?? input.completedAt;
  }

  snapshot.status = "failed";
  snapshot.completedAt = input.completedAt;
  snapshot.completionReason = input.completionReason;
  recordExecutionActivity(snapshot, input.completedAt);
}

export function calculateRemainingIdleTimeoutMs(
  snapshot: RunbookExecutionRecord,
  idleTimeoutMs: number,
  nowMs: number,
): number {
  const lastActivityMs = Date.parse(
    snapshot.lastActivityAt ?? snapshot.startedAt,
  );
  const elapsedMs = elapsedSinceLastActivity(lastActivityMs, nowMs);
  return Math.max(0, idleTimeoutMs - elapsedMs);
}

function elapsedSinceLastActivity(lastActivityMs: number, nowMs: number): number {
  if (Number.isFinite(lastActivityMs)) {
    return Math.max(0, nowMs - lastActivityMs);
  }

  return 0;
}

export function hasExecutionExceededIdleTimeout(
  snapshot: RunbookExecutionRecord,
  idleTimeoutMs: number,
  nowMs: number,
): boolean {
  const lastActivityMs = Date.parse(
    snapshot.lastActivityAt ?? snapshot.startedAt,
  );
  const idleMs = idleTimeMs(lastActivityMs, nowMs, idleTimeoutMs);
  return idleMs >= idleTimeoutMs;
}

function idleTimeMs(
  lastActivityMs: number,
  nowMs: number,
  idleTimeoutMs: number,
): number {
  if (Number.isFinite(lastActivityMs)) return nowMs - lastActivityMs;
  return idleTimeoutMs;
}
