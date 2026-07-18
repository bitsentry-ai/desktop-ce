import type { DiagnosisStateValue } from "../../../domain/value-objects/DiagnosisState";
import type { LogCategory } from "../../../domain/entities/DiagnosisRecord";
import type { DiagnosisLlmProviderKey } from "../../../../diagnosis/contracts";

/**
 * Inbound Port: DiagnoseEntryUseCase
 * Interface for running LLM diagnosis on a telemetry entry
 */

export interface DiagnoseEntryInput {
  entryId: number;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
  /** Correlates a worker-owned diagnosis operation across service boundaries. */
  executionId?: string;
  /** Absolute epoch deadline; late diagnosis results must not transition state. */
  deadlineAt?: number;
}

export interface DiagnoseEntryOutput {
  entryId: number;
  newState: DiagnosisStateValue;
  diagnosis: string;
  category?: LogCategory;
  categoryConfidence?: number;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
  currentActionLabel?: string;
  failureReason?: string;
}

export interface DiagnoseEntryUseCase {
  execute(input: DiagnoseEntryInput): Promise<DiagnoseEntryOutput>;
}
