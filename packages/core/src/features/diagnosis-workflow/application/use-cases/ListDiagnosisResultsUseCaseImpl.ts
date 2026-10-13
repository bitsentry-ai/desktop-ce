import type {
  DiagnosisResultItem,
  ListDiagnosisResultsUseCase,
  ListDiagnosisResultsInput,
  ListDiagnosisResultsOutput,
} from "../ports/inbound/ListDiagnosisResultsUseCase";
import type { DiagnosisRepository } from "../ports/outbound/DiagnosisRepository";
import type { TelemetryQueryService } from "../ports/outbound/TelemetryQueryService";
import type { DiagnosisStateValue } from "../../domain/value-objects/DiagnosisState";
import type { DiagnosisRecord } from "../../domain/entities/DiagnosisRecord";
import type { TelemetryEntryData } from "../ports/outbound/TelemetryQueryService";

/**
 * Application Service: ListDiagnosisResultsUseCaseImpl
 * Lists diagnosis results with filtering
 */
export class ListDiagnosisResultsUseCaseImpl implements ListDiagnosisResultsUseCase {
  constructor(
    private readonly diagnosisRepository: DiagnosisRepository,
    private readonly telemetryQueryService: TelemetryQueryService,
  ) {}

  async execute(
    input: ListDiagnosisResultsInput,
  ): Promise<ListDiagnosisResultsOutput> {
    const limit = this.normalizeLimit(input.limit);
    const { status, statuses } = this.normalizeStatus(input.status);

    const result = await this.diagnosisRepository.list({
      recordIds: input.recordIds,
      telemetryEntryId: input.telemetryEntryId,
      status,
      statuses,
      category: input.category,
      sourceCategory: input.sourceCategory,
      logLevel: input.logLevel,
      severity: input.severity,
      limit,
    });

    // Batch fetch telemetry entry data (single API call for all entries)
    const entryIds = result.items
      .map((item) => item.telemetryEntryId)
      .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
    const telemetryDataMap =
      await this.telemetryQueryService.getEntriesByIds(entryIds);

    return {
      records: result.items.flatMap((item) =>
        this.resultItem(item, telemetryDataMap),
      ),
      totalCount: result.total,
    };
  }

  private normalizeLimit(limit = 10): number {
    if (!Number.isFinite(limit) || limit <= 0) return 10;
    return Math.min(Math.floor(limit), 1000);
  }

  private normalizeStatus(statusRaw?: string): {
    status?: DiagnosisStateValue;
    statuses?: DiagnosisStateValue[];
  } {
    if (statusRaw === undefined || statusRaw.length === 0) return {};
    const s = statusRaw.trim().toLowerCase();
    if (s.length === 0) return {};

    // Special handling for "processing" which maps to multiple states
    if (s === "processing") {
      return { statuses: ["llm_assessed", "verification_pending"] };
    }

    const validStates: DiagnosisStateValue[] = [
      "pending",
      "llm_assessed",
      "verification_pending",
      "verified",
      "completed",
      "failed",
    ];

    if (validStates.includes(s as DiagnosisStateValue)) {
      return { status: s as DiagnosisStateValue };
    }

    return {};
  }

  private resultItem(
    item: DiagnosisRecord,
    telemetryDataMap: Map<number, TelemetryEntryData>,
  ): ListDiagnosisResultsOutput["records"] {
    if (item.id === undefined) return [];

    return [
      {
        id: item.id,
        telemetryEntryId: item.telemetryEntryId,
        stateHistory: [...item.stateHistory],
        stateTexts: item.getCurrentStateText() ?? "",
        createdAt: item.createdAt ?? new Date(),
        updatedAt: item.updatedAt ?? new Date(),
        ...this.telemetryFields(item, telemetryDataMap),
        category: item.category,
        categoryConfidence: item.categoryConfidence,
        sourceCategory: item.sourceCategory,
        sourceKind: item.sourceKind,
        logLevel: item.logLevel,
        severity: item.severity,
        description: item.description,
        environment: item.environment,
        sourceMetadata: item.sourceMetadata,
        normalizedData: item.normalizedData,
        sourceRef: item.sourceRef,
      },
    ];
  }

  private telemetryFields(
    item: DiagnosisRecord,
    telemetryDataMap: Map<number, TelemetryEntryData>,
  ): Pick<DiagnosisResultItem, "ruleDescription" | "agentName" | "ruleLevel"> {
    if (item.telemetryEntryId === undefined) return {};

    const telemetryData = telemetryDataMap.get(item.telemetryEntryId);
    if (telemetryData === undefined) return {};

    return {
      ruleDescription: telemetryData.ruleDescription,
      agentName: telemetryData.agentName,
      ruleLevel: telemetryData.ruleLevel,
    };
  }
}
