import type { SecureRedactor } from "../redactor";
import type { TemplateStepOutputRecord } from "../resolver";
import type {
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
} from "../runbooks.schemas";
import {
  bumpExecutionSnapshotVersion,
  markExecutionInterrupted,
} from "./reducer";

type ExecutionRedactorLike = Pick<SecureRedactor, "redact" | "redactString">;

function recordOrUndefined<T extends Record<string, unknown>>(
  value: T | undefined,
): T | undefined {
  if (value === undefined) return undefined;
  return { ...value };
}

function cloneExecutionStep(
  step: RunbookExecutionStepRecord,
): RunbookExecutionStepRecord {
  return {
    ...step,
    input: recordOrUndefined(step.input),
    metadata: recordOrUndefined(step.metadata),
    structuredOutput: recordOrUndefined(step.structuredOutput),
    streamDeltas: step.streamDeltas?.map((delta) => ({ ...delta })),
  };
}

export function cloneExecutionSnapshot(snapshot: null): null;
export function cloneExecutionSnapshot<T extends RunbookExecutionRecord>(
  snapshot: T,
): T;
export function cloneExecutionSnapshot(
  snapshot: RunbookExecutionRecord | null,
): RunbookExecutionRecord | null {
  if (snapshot === null) return null;

  return {
    ...snapshot,
    parameterValues: recordOrUndefined(snapshot.parameterValues),
    triggerContext: recordOrUndefined(snapshot.triggerContext),
    steps: snapshot.steps.map(cloneExecutionStep),
  };
}

export function createExecutionBoundarySnapshot(
  snapshot: RunbookExecutionRecord,
  redactedParameterValues: Record<string, string>,
  redactor: ExecutionRedactorLike,
): RunbookExecutionRecord {
  const next = cloneExecutionSnapshot(snapshot);
  next.parameterValues = redactedParameterValues;
  return redactor.redact(next);
}

export function createClaimedRunningSnapshot<T extends RunbookExecutionRecord>(
  snapshot: T,
  claimedAt: string,
): T {
  const next = cloneExecutionSnapshot(snapshot);
  next.status = "running";
  next.lastActivityAt = claimedAt;
  bumpExecutionSnapshotVersion(next);
  return next;
}

export function createInterruptedExecutionSnapshot<T extends RunbookExecutionRecord>(
  snapshot: T,
  input: {
    completedAt: string;
    completionReason?: NonNullable<RunbookExecutionRecord["completionReason"]>;
    errorMessage: string;
    includePendingStep?: boolean;
    status?: T["status"];
  },
): T {
  const next = cloneExecutionSnapshot(snapshot);
  markExecutionInterrupted(next, {
    completedAt: input.completedAt,
    completionReason: input.completionReason ?? "app_shutdown",
    errorMessage: input.errorMessage,
    includePendingStep: input.includePendingStep,
  });
  if (input.status !== undefined) {
    next.status = input.status;
  }
  bumpExecutionSnapshotVersion(next);
  return next;
}

export function buildExecutionContextFromSnapshot(
  snapshot: Pick<RunbookExecutionRecord, "steps">,
): TemplateStepOutputRecord[] {
  return snapshot.steps.map((step) => ({
    actionId: step.actionId,
    order: step.order,
    status: step.status,
    input: step.input,
    output: step.output,
    error: step.error,
    exitCode: step.exitCode,
    statusCode: step.statusCode,
    metadata: step.metadata,
    structuredOutput: step.structuredOutput,
  }));
}

export function addStepTemplateWarnings(
  redactor: ExecutionRedactorLike,
  step: Pick<RunbookExecutionStepRecord, "metadata">,
  warnings: string[],
): void {
  if (warnings.length === 0) {
    return;
  }

  const metadata = step.metadata ?? {};
  let existingWarnings: string[] = [];
  if (Array.isArray(metadata.templateWarnings)) {
    existingWarnings = metadata.templateWarnings.filter(
      (item): item is string => typeof item === "string",
    );
  }

  step.metadata = redactor.redact({
    ...metadata,
    templateWarnings: [...existingWarnings, ...warnings],
  });
}

export function mergeStepMetadata(
  redactor: ExecutionRedactorLike,
  existingMetadata: RunbookExecutionStepRecord["metadata"],
  nextMetadata: unknown,
): RunbookExecutionStepRecord["metadata"] {
  if (
    nextMetadata === null ||
    typeof nextMetadata !== "object" ||
    Array.isArray(nextMetadata)
  ) {
    return existingMetadata;
  }

  return redactor.redact({
    ...existingMetadata,
    ...nextMetadata,
  });
}

export function redactExecutionString(
  redactor: ExecutionRedactorLike,
  value: string,
): string {
  return redactor.redactString(value);
}

export function extractFiniteNumericMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
