import type { TelemetryActionConfigWithCli as TelemetryActionConfig } from "./runbooks.schemas";
import type {
  RunbookActionRecord as SharedRunbookActionRecord,
  RunbookContextV1 as SharedRunbookContextV1,
  RunbookRecord as SharedRunbookRecord,
} from "./desktop-runbook.types";

export {
  DEFAULT_RUNBOOK_IDLE_TIMEOUT_MINUTES,
  MAX_RUNBOOK_IDLE_TIMEOUT_MINUTES,
  normalizeJournalTimeWindowParameterValues,
  normalizeRunbookActionType,
  normalizeRunbookIdleTimeout,
  normalizeRunbookParameterValues,
  normalizeRunbookTriggerContext,
  parseRunbookExecutionSource,
  parseRunbookIdleTimeoutForUpdate,
} from "./desktop-runbook.types";

export type {
  DesktopExportedRunbookV1,
  DesktopRunbookExportArtifactV1,
  RunbookActionParameter,
  RunbookActionType,
  RunbookExecutionCompletionReason,
  RunbookExecutionRecord,
  RunbookExecutionSource,
  RunbookExecutionStatus,
  RunbookExecutionStepRecord,
  RunbookExecutionStepStatus,
  RunbookHttpHeader,
  RunbookHttpMethod,
  RunbookLlmProviderKey,
  RunbookParameterValues,
  RunbookTriggerContext,
  RunbookTriggerSurface,
} from "./desktop-runbook.types";

export type RunbookActionRecord =
  SharedRunbookActionRecord<TelemetryActionConfig>;
export type RunbookRecord = SharedRunbookRecord<TelemetryActionConfig>;
export type RunbookContextV1 = SharedRunbookContextV1<TelemetryActionConfig>;
