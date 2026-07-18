import type { LogCategory } from "../../../domain/entities/DiagnosisRecord";
import type { DiagnosisLlmProviderKey } from "../../../../diagnosis/contracts";

/**
 * Outbound Port: LLMService
 * Interface for LLM-based analysis
 */

export interface LLMAnalysisRequest {
  ruleDescription: string;
  entrySource: Record<string, unknown>;
  ruleGroups?: string[];
  initialCategory?: LogCategory;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface LLMAnalysisResult {
  diagnosisText: string;
  refinedCategory?: LogCategory;
  categoryConfidence?: number;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
}

/** Internal operation context; it is not serialized into LLM prompts. */
export interface LLMOperationOptions {
  signal?: AbortSignal;
  executionId?: string;
}

export interface LLMRecommendationRequest {
  assessment: string;
  verificationText?: string;
  diagnosisConfirmation?: string;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface LLMRecommendationResult {
  recommendationText: string;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
}

export interface LLMService {
  /**
   * Analyzes a telemetry entry and returns a diagnosis
   */
  analyze(
    request: LLMAnalysisRequest,
    options?: LLMOperationOptions,
  ): Promise<LLMAnalysisResult>;

  /**
   * Generates a concise remediation recommendation for an administrator
   */
  recommend(
    request: LLMRecommendationRequest,
    options?: LLMOperationOptions,
  ): Promise<LLMRecommendationResult>;
}
