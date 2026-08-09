import type { DiagnosisLlmProviderKey } from "../../../../diagnosis/contracts";

/**
 * Outbound Port: EvidenceVerificationService
 * Interface for evidence-backed diagnosis verification.
 */

export interface EvidenceVerificationRequest {
  entryId?: number;
  entryIndex?: string;
  ruleId?: string;
  ruleDescription: string;
  ruleLevel?: number;
  ruleGroups?: string[];
  category?: string;
  entrySource: Record<string, unknown>;
  entryTimestamp: Date;
  agentName?: string;
  agentIp?: string;
  diagnosisText: string;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface EvidenceVerificationResult {
  verificationText: string;
  toolsUsed: string[];
  passed: boolean;
  verificationMethod?: string;
  evidenceSourcesUsed?: string[];
  evidenceQueries?: Array<Record<string, unknown>>;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
}

/** Internal operation context; it is not serialized with verification input. */
export interface EvidenceVerificationOperationOptions {
  signal?: AbortSignal;
  executionId?: string;
}

export interface EvidenceVerificationService {
  /**
   * Verifies a diagnosis with configured evidence sources.
   */
  verify(
    request: EvidenceVerificationRequest,
    options?: EvidenceVerificationOperationOptions,
  ): Promise<EvidenceVerificationResult>;
}
