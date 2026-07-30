import { z } from "zod";
import type {
  RunbookExecutionRecord,
  RunbookContextV1,
  RunbookParameterValues,
  RunbookRecord,
} from "./desktop-runbook.types";
import {
  runbookExecutionEventSchema,
  runbookExecutionRequestSchema,
  runbookExecutionResultSchema,
  type RunbookExecutionEvent,
  type RunbookExecutionRequest,
  type RunbookExecutionResult,
  type RunbookReference,
} from "./desktop-runbook.gateway.schemas";
import type { RunbookGateway } from './runbook.gateway'

const executionReferenceSchema = z.string().trim().min(1);
const incidentIdSchema = z.string().trim().min(1);

type ExecutionStartOptions = {
  parameterValues?: RunbookParameterValues;
  source?: "manual" | "agent";
  triggerContext?: RunbookExecutionRequest["triggerContext"];
  incidentThreadId?: string;
  accessLevel?: RunbookExecutionRequest["accessLevel"];
  requestKey?: string;
};

type ExecutionServiceEvent = {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: RunbookExecutionRecord;
};

export interface DesktopRunbookGatewayDependencies {
  store: {
    list(): Promise<RunbookRecord[]>;
    getRunbookOrThrow(id: string): Promise<RunbookRecord>;
    exportContext(payload: Record<string, unknown>): Promise<RunbookContextV1>;
  };
  executionService: {
    start(
      runbookId: string,
      options?: ExecutionStartOptions,
    ): Promise<{ executionId: string; resultId: string }>;
    get(executionId: string): Promise<RunbookExecutionRecord | null>;
    getLatestForIncidentThread(
      incidentThreadId: string,
    ): Promise<RunbookExecutionRecord | null>;
    getLatestWithResultForIncidentThread(
      incidentThreadId: string,
    ): Promise<{ resultId: string; execution: RunbookExecutionRecord } | null>;
    getByRequestKey(
      runbookId: string,
      requestKey: string,
    ): Promise<{ resultId: string; execution: RunbookExecutionRecord } | null>;
    waitForCompletion(
      executionId: string,
      options?: {
        signal?: AbortSignal;
        pollIntervalMs?: number;
        timeoutMs?: number;
      },
    ): Promise<RunbookExecutionRecord | null>;
    subscribe(listener: (event: ExecutionServiceEvent) => void): () => void;
    cancel(executionId: string): Promise<void>;
  };
}

function toRunbookReference(runbook: RunbookRecord): RunbookReference {
  return {
    id: runbook.id,
    title: runbook.title,
    revisionNumber: runbook.revisionNumber,
  };
}

function toExecutionEvent(event: ExecutionServiceEvent): RunbookExecutionEvent {
  return runbookExecutionEventSchema.parse({
    eventId: `snapshot:${event.executionId}:${String(event.execution.snapshotVersion ?? 0)}`,
    occurredAt:
      event.execution.completedAt ??
      event.execution.lastActivityAt ??
      event.execution.startedAt,
    resultId: event.resultId,
    executionId: event.executionId,
    incidentId: event.incidentThreadId ?? null,
    execution: event.execution,
  });
}

function toExecutionResult(input: {
  resultId: string;
  execution: RunbookExecutionRecord;
  runbook: RunbookReference;
  deduplicated: boolean;
}): RunbookExecutionResult {
  return runbookExecutionResultSchema.parse({
    executionId: input.execution.executionId,
    resultId: input.resultId,
    runbook: input.runbook,
    execution: input.execution,
    deduplicated: input.deduplicated,
  });
}

export function createDesktopRunbookGateway(
  dependencies: DesktopRunbookGatewayDependencies,
): RunbookGateway {
  const { store, executionService } = dependencies;
  const pendingStarts = new Map<string, Promise<RunbookExecutionResult>>();

  const start = async (
    rawRequest: RunbookExecutionRequest,
  ): Promise<RunbookExecutionResult> => {
    const request = runbookExecutionRequestSchema.parse(rawRequest);
    const idempotencyKey = `${request.runbookId}:${request.requestKey}`;
    const pending = pendingStarts.get(idempotencyKey);
    if (pending !== undefined) {
      return pending;
    }

    const operation = (async () => {
      const previous = await executionService.getByRequestKey(
        request.runbookId,
        request.requestKey,
      );
      if (previous !== null) {
        return toExecutionResult({
          resultId: previous.resultId,
          execution: previous.execution,
          runbook: {
            id: previous.execution.runbookId,
            title: previous.execution.runbookTitle,
            revisionNumber: previous.execution.runbookRevisionNumber ?? 1,
          },
          deduplicated: true,
        });
      }

      const runbook = await store.getRunbookOrThrow(request.runbookId);
      if (
        request.expectedRevisionNumber !== undefined &&
        request.expectedRevisionNumber !== runbook.revisionNumber
      ) {
        throw new Error(
          `Runbook '${runbook.id}' changed from revision ${String(request.expectedRevisionNumber)} to ${String(runbook.revisionNumber)} before it could start`,
        );
      }
      if (runbook.actions.length === 0) {
        throw new Error(`Runbook '${runbook.id}' has no executable actions`);
      }

      const started = await executionService.start(runbook.id, {
        parameterValues: request.parameterValues,
        source: request.source,
        triggerContext: request.triggerContext,
        incidentThreadId: request.incidentId,
        accessLevel: request.accessLevel,
        requestKey: request.requestKey,
      });
      const execution = await executionService.get(started.executionId);
      if (execution === null) {
        throw new Error(`Runbook execution '${started.executionId}' was not persisted`);
      }

      return toExecutionResult({
        resultId: started.resultId,
        execution,
        runbook: toRunbookReference(runbook),
        deduplicated: false,
      });
    })();

    pendingStarts.set(idempotencyKey, operation);
    try {
      return await operation;
    } finally {
      pendingStarts.delete(idempotencyKey);
    }
  };

  return {
    async listExecutable() {
      const runbooks = await store.list();
      return runbooks.filter((runbook) => runbook.actions.length > 0);
    },
    getRunbookContext(runbookId) {
      return store.exportContext({ id: executionReferenceSchema.parse(runbookId) });
    },
    start,
    get(executionId) {
      return executionService.get(executionReferenceSchema.parse(executionId));
    },
    getLatestForIncidentThread(incidentThreadId) {
      return executionService.getLatestForIncidentThread(
        incidentIdSchema.parse(incidentThreadId),
      );
    },
    waitForCompletion(executionId, options) {
      return executionService.waitForCompletion(
        executionReferenceSchema.parse(executionId),
        options,
      );
    },
    subscribe(incidentId, listener) {
      const validatedIncidentId = incidentIdSchema.parse(incidentId);
      let active = true;
      const publish = (event: ExecutionServiceEvent) => {
        if (active && event.incidentThreadId === validatedIncidentId) {
          listener(toExecutionEvent(event));
        }
      };
      const unsubscribe = executionService.subscribe(publish);

      // A subscriber always sees the most recent persisted state after a
      // restart, then receives live snapshots without falling back to polling.
      void executionService
        .getLatestWithResultForIncidentThread(validatedIncidentId)
        .then((latest) => {
          if (active && latest !== null) {
            listener(
              toExecutionEvent({
                resultId: latest.resultId,
                executionId: latest.execution.executionId,
                incidentThreadId: validatedIncidentId,
                execution: latest.execution,
              }),
            );
          }
        })
        .catch(() => {
          // Subscription remains useful for future events if persisted history
          // cannot be read during application shutdown.
        });

      return () => {
        active = false;
        unsubscribe();
      };
    },
    cancel(executionId) {
      return executionService.cancel(executionReferenceSchema.parse(executionId));
    },
  };
}
