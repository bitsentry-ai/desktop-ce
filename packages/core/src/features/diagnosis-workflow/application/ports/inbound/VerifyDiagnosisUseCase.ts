import type { DiagnosisStateValue } from "../../../domain/value-objects/DiagnosisState";
import type { DiagnosisLlmProviderKey } from "../../../../diagnosis/contracts";

/**
 * Inbound Port: VerifyDiagnosisUseCase
 * Interface for verifying a diagnosis using MCP tools
 */

export interface VerifyDiagnosisInput {
  entryId: number;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface VerifyDiagnosisOutput {
  entryId: number;
  newState: DiagnosisStateValue;
  verificationText: string;
  mcpToolsUsed: string[];
  verificationPassed: boolean;
  verificationMethod?: string;
  evidenceSourcesUsed?: string[];
  evidenceQueries?: Array<Record<string, unknown>>;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
  currentActionLabel?: string;
  failureReason?: string;
}

export interface VerifyDiagnosisUseCase {
  execute(input: VerifyDiagnosisInput): Promise<VerifyDiagnosisOutput>;
}
