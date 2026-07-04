import type { DiagnosisLlmProviderKey } from "../../../../diagnosis/contracts";

/**
 * Outbound Port: MCPService
 * Interface for MCP-based verification
 */

export interface MCPVerificationRequest {
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

export interface MCPVerificationResult {
  verificationText: string;
  toolsUsed: string[];
  passed: boolean;
  verificationMethod?: string;
  evidenceSourcesUsed?: string[];
  evidenceQueries?: Array<Record<string, unknown>>;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
}

export interface MCPService {
  /**
   * Verifies a diagnosis using MCP tools
   */
  verify(request: MCPVerificationRequest): Promise<MCPVerificationResult>;
}
