import { Effect } from "effect";

export type OrchestrationFailureKind =
  | "cancelled"
  | "timeout"
  | "rate_limited"
  | "retry_exhausted"
  | "remote_unavailable"
  | "process_exit"
  | "protocol_violation"
  | "validation_failure"
  | "operation";

export class OrchestrationError extends Error {
  readonly name = "OrchestrationError";

  constructor(
    readonly kind: OrchestrationFailureKind,
    readonly operation: string,
    readonly cause?: unknown,
  ) {
    super(formatOrchestrationErrorMessage(kind, operation, cause));
  }
}

export interface RunOrchestratedOperationOptions<T> {
  operation: string;
  signal: AbortSignal;
  timeoutMs?: number | null;
  executionId?: string;
  provider?: string;
  attempt?: number;
  onTrace?: (event: OrchestrationTraceEvent) => void;
  execute: (signal: AbortSignal) => Promise<T>;
}

export interface OrchestrationTraceEvent {
  operation: string;
  executionId?: string;
  provider?: string;
  attempt?: number;
  timeoutMs?: number;
  elapsedMs: number;
  outcome: "succeeded" | "failed";
  failureKind?: OrchestrationFailureKind;
  cancellationSource?: "caller" | "deadline";
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

function formatOrchestrationErrorMessage(
  kind: OrchestrationFailureKind,
  operation: string,
  cause?: unknown,
): string {
  if (kind === "cancelled") {
    return `${operation} cancelled`;
  }

  if (kind === "timeout") {
    return `${operation} timed out`;
  }

  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }

  return `${operation} failed`;
}

function linkAbortSignals(signals: readonly AbortSignal[]): LinkedAbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
  }

  const activeSignals = signals.filter((signal) => !signal.aborted);
  for (const signal of activeSignals) {
    signal.addEventListener("abort", abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      for (const signal of activeSignals) {
        signal.removeEventListener("abort", abort);
      }
    },
  };
}

function emitTrace(
  onTrace: RunOrchestratedOperationOptions<unknown>["onTrace"],
  event: OrchestrationTraceEvent,
): void {
  if (onTrace === undefined) {
    console.info("[orchestration]", event);
    return;
  }

  try {
    onTrace(event);
  } catch {
    // Observability must not alter the operation result or its cleanup path.
  }
}

function toOrchestrationError(
  cause: unknown,
  options: RunOrchestratedOperationOptions<unknown>,
): OrchestrationError {
  if (cause instanceof OrchestrationError) {
    return cause;
  }

  const kind = options.signal.aborted ? "cancelled" : "operation";
  return new OrchestrationError(kind, options.operation, cause);
}

function getCancellationSource(
  kind: OrchestrationFailureKind,
): OrchestrationTraceEvent["cancellationSource"] {
  if (kind === "cancelled") {
    return "caller";
  }
  if (kind === "timeout") {
    return "deadline";
  }
  return undefined;
}

/**
 * Runs a side-effecting Promise through Effect while keeping the caller's
 * Promise-based API intact. The operation receives a signal that is aborted
 * for either caller cancellation or an Effect deadline.
 */
export async function runOrchestratedOperation<T>(
  options: RunOrchestratedOperationOptions<T>,
): Promise<T> {
  const startedAt = Date.now();
  const operation = Effect.tryPromise({
    try: async (effectSignal) => {
      const linkedSignal = linkAbortSignals([options.signal, effectSignal]);
      try {
        return await options.execute(linkedSignal.signal);
      } finally {
        linkedSignal.dispose();
      }
    },
    catch: (cause) => toOrchestrationError(cause, options),
  });

  const boundedOperation =
    options.timeoutMs === undefined || options.timeoutMs === null
      ? operation
      : operation.pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs,
            onTimeout: () =>
              new OrchestrationError("timeout", options.operation),
          }),
        );

  const outcome = await Effect.runPromise(Effect.either(boundedOperation));
  if (outcome._tag === "Left") {
    const error = outcome.left;
    emitTrace(options.onTrace, {
      operation: options.operation,
      executionId: options.executionId,
      provider: options.provider,
      attempt: options.attempt,
      timeoutMs: options.timeoutMs ?? undefined,
      elapsedMs: Date.now() - startedAt,
      outcome: "failed",
      failureKind: error.kind,
      cancellationSource: getCancellationSource(error.kind),
    });
    throw error;
  }

  emitTrace(options.onTrace, {
    operation: options.operation,
    executionId: options.executionId,
    provider: options.provider,
    attempt: options.attempt,
    timeoutMs: options.timeoutMs ?? undefined,
    elapsedMs: Date.now() - startedAt,
    outcome: "succeeded",
  });
  return outcome.right;
}
