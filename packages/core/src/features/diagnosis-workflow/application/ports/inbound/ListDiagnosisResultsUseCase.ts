import type {
  StateHistoryEntry,
  LogCategory,
  DiagnosisSourceCategory,
  DiagnosisSourceKind,
  DiagnosisLogLevel,
  DiagnosisSeverity,
  DiagnosisSourceRef,
} from "../../../domain/entities/DiagnosisRecord";

/**
 * Inbound Port: ListDiagnosisResultsUseCase
 * Interface for listing diagnosis results
 */

export interface ListDiagnosisResultsInput {
  recordIds?: number[];
  telemetryEntryId?: number;
  status?: string;
  category?: LogCategory;
  sourceCategory?: DiagnosisSourceCategory;
  logLevel?: DiagnosisLogLevel;
  severity?: DiagnosisSeverity;
  limit?: number;
}

export interface DiagnosisResultItem {
  id: number;
  telemetryEntryId?: number;
  stateHistory: StateHistoryEntry[];
  stateTexts: string;
  createdAt: Date;
  updatedAt: Date;
  ruleDescription?: string;
  agentName?: string;
  ruleLevel?: number;
  category?: LogCategory;
  categoryConfidence?: number;
  sourceCategory: DiagnosisSourceCategory;
  sourceKind: DiagnosisSourceKind;
  logLevel: DiagnosisLogLevel;
  severity: DiagnosisSeverity;
  description?: string;
  environment?: string;
  sourceMetadata?: Record<string, unknown>;
  normalizedData?: Record<string, unknown>;
  sourceRef: DiagnosisSourceRef;
}

export interface ListDiagnosisResultsOutput {
  records: DiagnosisResultItem[];
  totalCount: number;
}

export interface ListDiagnosisResultsUseCase {
  execute(
    input: ListDiagnosisResultsInput,
  ): Promise<ListDiagnosisResultsOutput>;
}
