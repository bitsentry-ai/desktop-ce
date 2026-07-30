import type {
  RunbookContextV1,
  RunbookExecutionRecord,
  RunbookRecord,
} from './desktop-runbook.types'
import type {
  RunbookExecutionEvent,
  RunbookExecutionRequest,
  RunbookExecutionResult,
} from './desktop-runbook.gateway.schemas'

/**
 * Product-neutral boundary for discovering and executing authored runbooks.
 *
 * Desktop implements this over its local executor; Cloud implements the same
 * serializable contract over its authenticated tRPC transport. Consumers must
 * depend on this interface rather than on either product's runtime.
 */
export interface RunbookGateway {
  listExecutable(): Promise<RunbookRecord[]>
  getRunbookContext(runbookId: string): Promise<RunbookContextV1>
  start(request: RunbookExecutionRequest): Promise<RunbookExecutionResult>
  get(executionId: string): Promise<RunbookExecutionRecord | null>
  getLatestForIncidentThread(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null>
  waitForCompletion(
    executionId: string,
    options?: {
      signal?: AbortSignal
      pollIntervalMs?: number
      timeoutMs?: number
    },
  ): Promise<RunbookExecutionRecord | null>
  subscribe(
    incidentId: string,
    listener: (event: RunbookExecutionEvent) => void,
  ): () => void
  cancel(executionId: string): Promise<void>
}
