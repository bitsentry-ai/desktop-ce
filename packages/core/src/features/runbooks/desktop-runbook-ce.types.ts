import type { TelemetryActionConfigWithCli as TelemetryActionConfig } from "./runbooks.schemas";
import type {
  RunbookActionRecord as SharedRunbookActionRecord,
  RunbookContextV1 as SharedRunbookContextV1,
  RunbookRecord as SharedRunbookRecord,
} from "./desktop-runbook.types";

export {
  normalizeJournalTimeWindowParameterValues,
  normalizeRunbookIdleTimeout,
  normalizeRunbookParameterValues,
  normalizeRunbookTriggerContext,
  parseRunbookExecutionSource,
  parseRunbookIdleTimeoutForUpdate,
} from "./desktop-runbook.types";

export type {
  DesktopRunbookExportArtifactV1,
  RunbookActionType,
  RunbookExecutionRecord,
  RunbookExecutionStepRecord,
  RunbookParameterValues,
} from "./desktop-runbook.types";

export type RunbookActionRecord =
  SharedRunbookActionRecord<TelemetryActionConfig>;
export type RunbookRecord = SharedRunbookRecord<TelemetryActionConfig>;
export type RunbookContextV1 = SharedRunbookContextV1<TelemetryActionConfig>;
