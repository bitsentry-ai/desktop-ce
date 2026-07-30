import type {
  RunbookExecutionRecord,
  RunbookExecutionSource,
  RunbookParameterValues,
  RunbookRecord,
  RunbookTriggerContext,
} from "./desktop-runbook.types";

/**
 * The app-facing seam for discovering and executing desktop runbooks.
 *
 * Adapters such as Electron IPC, the incident agent, and the standalone CLI
 * should depend on this interface rather than independently composing a store
 * and an execution service. The execution service remains the implementation
 * that runs steps; this gateway owns the public execution vocabulary.
 */
export interface DesktopRunbookGateway {
  listExecutable(): Promise<RunbookRecord[]>;
  start(
    runbookId: string,
    options?: {
      parameterValues?: RunbookParameterValues;
      source?: RunbookExecutionSource;
      triggerContext?: RunbookTriggerContext;
      incidentThreadId?: string;
      accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
    },
  ): Promise<{ executionId: string; resultId: string }>;
  get(executionId: string): Promise<RunbookExecutionRecord | null>;
  getLatestForIncidentThread(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null>;
  waitForCompletion(
    executionId: string,
    options?: {
      signal?: AbortSignal;
      pollIntervalMs?: number;
      timeoutMs?: number;
    },
  ): Promise<RunbookExecutionRecord | null>;
  cancel(executionId: string): Promise<void>;
}

export interface DesktopRunbookGatewayDependencies {
  store: {
    list(): Promise<RunbookRecord[]>;
  };
  executionService: Omit<DesktopRunbookGateway, "listExecutable">;
}

export function createDesktopRunbookGateway(
  dependencies: DesktopRunbookGatewayDependencies,
): DesktopRunbookGateway {
  const { store, executionService } = dependencies;

  return {
    async listExecutable() {
      const runbooks = await store.list();
      return runbooks.filter((runbook) => runbook.actions.length > 0);
    },
    start(runbookId, options) {
      return executionService.start(runbookId, options);
    },
    get(executionId) {
      return executionService.get(executionId);
    },
    getLatestForIncidentThread(incidentThreadId) {
      return executionService.getLatestForIncidentThread(incidentThreadId);
    },
    waitForCompletion(executionId, options) {
      return executionService.waitForCompletion(executionId, options);
    },
    cancel(executionId) {
      return executionService.cancel(executionId);
    },
  };
}
