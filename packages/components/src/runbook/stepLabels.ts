import type { useTranslation } from "@bitsentry-ce/i18n";
import type { RunbookActionType, RunbookExecutionStepRecord } from "../services/contracts";

type TranslationFn = ReturnType<typeof useTranslation>["t"];

/** The reader-facing name of a step's action type, such as "Shell" or "HTTP". */
export function actionTypeLabel(t: TranslationFn, type: RunbookActionType): string {
  switch (type) {
    case "shell":
      return t("common.incidentArtifactsRail.actionType.shell");
    case "llm":
      return t("common.incidentArtifactsRail.actionType.llm");
    case "http":
      return t("common.incidentArtifactsRail.actionType.http");
    case "plugin":
      return t("common.incidentArtifactsRail.actionType.plugin");
    case "external_source":
      return t("common.incidentArtifactsRail.actionType.external_source");
    case "telemetry_existing_entry":
      return t(
        "common.incidentArtifactsRail.actionType.telemetry_existing_entry",
      );
    case "data_source_query":
      return t("common.incidentArtifactsRail.actionType.data_source_query");
    case "telemetry_ingest":
      return t("common.incidentArtifactsRail.actionType.telemetry_ingest");
    case "diagnosis":
      return t("common.incidentArtifactsRail.actionType.diagnosis_diagnose");
  }
}

/** The reader-facing name of a step's status, such as "Completed". */
export function stepStatusLabel(
  t: TranslationFn,
  status: RunbookExecutionStepRecord["status"],
): string {
  switch (status) {
    case "awaiting_approval":
      return t("common.results.statusAwaitingApproval");
    case "skipped":
      return t("common.results.statusSkipped");
    case "pending":
      return t("common.incidentArtifactsRail.stepStatus.pending");
    case "running":
      return t("common.incidentArtifactsRail.stepStatus.running");
    case "completed":
      return t("common.incidentArtifactsRail.stepStatus.completed");
    case "failed":
      return t("common.incidentArtifactsRail.stepStatus.failed");
    case "cancelled":
      return t("common.incidentArtifactsRail.stepStatus.cancelled");
  }
}
