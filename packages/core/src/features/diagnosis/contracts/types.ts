export type DiagnosisLogLevel = "infrastructure" | "application" | "unknown";

export type DiagnosisSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "unknown";

export type DiagnosisStateValue =
  | "pending"
  | "llm_assessed"
  | "verification_pending"
  | "verified"
  | "completed"
  | "failed";

export type DiagnosisLlmProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter";

export interface DiagnosisQuery {
  record_ids?: string;
  telemetry_entry_id?: number;
  status?: string;
  source_category?: string;
  log_level?: DiagnosisLogLevel;
  severity?: DiagnosisSeverity;
  limit?: number;
}

export interface StateHistoryItem {
  fromState: string | null;
  toState: string;
  transitionedAt: string;
  metadata?: Record<string, unknown>;
}

export interface DiagnosisRecord {
  id: number;
  telemetry_entry_id?: number;
  source_category: string;
  source_kind: string;
  source_table_name: string;
  source_field_name: string;
  source_key_value: string;
  log_level: DiagnosisLogLevel;
  severity: DiagnosisSeverity;
  category: string;
  category_confidence?: number;
  description?: string;
  environment?: string;
  source_metadata?: Record<string, unknown>;
  normalized_data?: Record<string, unknown>;
  state_history: StateHistoryItem[];
  state_texts: string;
  created_at: string;
  updated_at: string;
  rule_description?: string;
  agent_name?: string;
  rule_level?: number;
  provider_used?: DiagnosisLlmProviderKey;
  model_used?: string;
  current_action_label?: string;
  failure_reason?: string;
}

export interface DiagnosisResultsResponse {
  records: DiagnosisRecord[];
  total_count: number;
}

export type DiagnosisTicketPriority =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "URGENT"
  | "CRITICAL";

export type DiagnosisTicketStatus =
  | "NEW"
  | "OPEN"
  | "PENDING"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED"
  | "CANCELLED";

export interface CreateTicketFromDiagnosisInput {
  diagnosisId: number;
  telemetryEntryId: number;
  priority?: DiagnosisTicketPriority;
  additionalNotes?: string;
  async?: boolean;
}

export interface DiagnosisTicket {
  id: string;
  diagnosisId: number;
  telemetryEntryId: number;
  externalTicketId: string;
  externalTicketNumber: string;
  ticketProvider: string;
  ticketUrl: string | null;
  ticketStatus: DiagnosisTicketStatus;
  ticketPriority: DiagnosisTicketPriority;
  ticketCreatedAt: Date;
  ticketUpdatedAt: Date;
  ticketResolvedAt: Date | null;
  ruleDescription: string | null;
  ruleLevel: number | null;
  agentName: string | null;
  agentIp: string | null;
  stateTexts: string | null;
  diagnosisState: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelemetryEntry {
  id: number;
  telemetry_id: number;
  entry_id: string;
  entry_index: string;
  entry_source: Record<string, unknown>;
  entry_timestamp: string;
  agent_name: string;
  agent_ip: string;
  rule_id: string;
  rule_description: string;
  rule_level: number;
  created_at: string;
  updated_at: string;
  current_state: DiagnosisStateValue;
}

export interface TelemetryEntryResponse {
  entry: TelemetryEntry | null;
}

export interface DiagnoseEntryRequest {
  entryId: number;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface DiagnoseEntryResponse {
  entryId: number;
  newState: DiagnosisStateValue;
  diagnosis: string;
  category?: string;
  categoryConfidence?: number;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
  currentActionLabel?: string;
  failureReason?: string;
}

export interface VerifyDiagnosisRequest {
  entryId: number;
  approved?: boolean;
  reason?: string;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface VerifyDiagnosisResponse {
  entryId: number;
  newState: DiagnosisStateValue;
  verificationText: string;
  evidenceToolsUsed: string[];
  verificationPassed: boolean;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
  currentActionLabel?: string;
  failureReason?: string;
}

export interface RecommendDiagnosisRequest {
  entryId: number;
  llmProviderKey?: DiagnosisLlmProviderKey;
  llmModel?: string;
}

export interface RecommendDiagnosisResponse {
  entryId: number;
  newState: DiagnosisStateValue;
  recommendationText: string;
  providerUsed?: DiagnosisLlmProviderKey;
  modelUsed?: string;
  currentActionLabel?: string;
  failureReason?: string;
}

export interface UpdateDiagnosisStateRequest {
  entryId: number;
  toState: DiagnosisStateValue;
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateDiagnosisStateResponse {
  entryId: number;
  newState: DiagnosisStateValue;
  fromState?: DiagnosisStateValue;
  updatedAt: string;
}

export interface ExistingDiagnosisTicketResult {
  existing: true;
  ticketId: string;
  ticketNumber: string;
  ticketUrl: string | null;
  provider: string;
}

export interface QueuedDiagnosisTicketResult {
  queued: boolean;
  eventId: number;
  message: string;
}

export interface CreatedDiagnosisTicketResult {
  success: true;
  ticketId: string;
  ticketNumber: string;
  ticketUrl: string | null;
  provider: string;
}

export type CreateDiagnosisTicketResult =
  | ExistingDiagnosisTicketResult
  | QueuedDiagnosisTicketResult
  | CreatedDiagnosisTicketResult;

export interface DiagnosisTicketCreateEventData {
  sourceType: "diagnosis";
  sourceId: number;
  telemetryEntryId: number;
  provider: string;
  userId: number;
  data: {
    title: string;
    description: string;
    priority: DiagnosisTicketPriority;
    tags: string[];
    metadata: {
      diagnosisId: number;
      telemetryEntryId: number;
      ruleId: string;
      ruleLevel: number;
      agentName: string;
      agentIp: string;
    };
  };
  diagnosisCache: {
    ruleDescription: string;
    ruleLevel: number;
    agentName: string;
    agentIp: string;
    stateTexts: string;
    diagnosisState: string;
  };
}
