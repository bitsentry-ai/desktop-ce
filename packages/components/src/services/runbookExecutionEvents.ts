type ExecutionShape = { status: string; snapshotVersion?: number; steps: unknown[] };

const MAX_TRACKED_EXECUTIONS = 500;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

type ExecutionEvent<T> = {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: T;
  /** Set on an output flush of a running execution, whose `execution.steps` is then empty. */
  step?: { index: number; record: unknown };
};

/**
 * Hands `handler` whole executions. Main sends an output flush as just the changed step, which applies to the
 * version before it; after a missed version the whole execution is fetched instead. Nothing older than the
 * highest version already handed over is delivered.
 */
export function subscribeToFullExecutions<T extends ExecutionShape>(
  subscribe: (handler: (event: ExecutionEvent<T>) => void) => () => void,
  getExecution: (executionId: string) => Promise<T | null>,
  handler: (event: ExecutionEvent<T>) => void,
): () => void {
  const latest = new Map<string, ExecutionShape>();
  /** Executions with a fetch in flight, to the highest step version that arrived during it. */
  const fetching = new Map<string, number>();
  let active = true;
  const deliveredVersion = (executionId: string) => {
    const execution = latest.get(executionId);
    return execution === undefined ? -1 : (execution.snapshotVersion ?? 0);
  };
  const deliver = (event: ExecutionEvent<T>, execution: T) => {
    // Finished executions stay too, so a late fetch cannot revert them; the least recently updated goes past the cap.
    // Only their version matters then, so their step outputs are not kept.
    const { status, snapshotVersion } = execution;
    latest.delete(event.executionId);
    latest.set(event.executionId, TERMINAL_STATUSES.has(status) ? { status, snapshotVersion, steps: [] } : execution);
    if (latest.size > MAX_TRACKED_EXECUTIONS) latest.delete(latest.keys().next().value as string);
    handler({ ...event, execution, step: undefined });
  };
  const fetchExecution = (event: ExecutionEvent<T>) => {
    const { executionId } = event;
    const missed = fetching.get(executionId);
    if (missed !== undefined) {
      fetching.set(executionId, Math.max(missed, event.execution.snapshotVersion ?? 0));
      return;
    }
    fetching.set(executionId, -1);
    void getExecution(executionId)
      .then((execution) => {
        if (active && execution !== null && (execution.snapshotVersion ?? 0) > deliveredVersion(executionId)) deliver(event, execution);
      })
      .catch(() => undefined)
      .finally(() => {
        const missedVersion = fetching.get(executionId) ?? -1;
        fetching.delete(executionId);
        if (active && missedVersion > deliveredVersion(executionId)) fetchExecution(event);
      });
  };
  const unsubscribe = subscribe((event) => {
    const { step } = event;
    if (step === undefined) {
      if ((event.execution.snapshotVersion ?? 0) >= deliveredVersion(event.executionId)) deliver(event, event.execution);
      return;
    }
    const previous = latest.get(event.executionId);
    const version = event.execution.snapshotVersion ?? 0;
    const previousVersion = previous?.snapshotVersion ?? -1;
    if (previous === undefined || version > previousVersion + 1) {
      fetchExecution(event);
      return;
    }
    if (version <= previousVersion) return;
    const steps = [...previous.steps];
    steps[step.index] = step.record;
    deliver(event, { ...event.execution, steps } as T);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}
