import type {
  AccessLevel,
  AgentThreadSnapshot,
  InteractionMode,
} from "../chat/types";
import type {
  AllSettingsDto,
  AuditLog,
  AuditLogQuery,
  EmailOtpRequest,
  EmailOtpResponse,
  EmailOtpVerifyRequest,
  EmailOtpVerifyResponse,
  GeneralSettingsDto,
  MagicLinkRequest,
  MagicLinkResponse,
  MagicLinkVerifyRequest,
  MagicLinkVerifyResponse,
  NotificationSettingsDto,
  SecurityPolicyDto,
  ThreatIntelligenceDto,
  User,
  VulnerabilityTimeline,
} from "../types/api.types";
import type { TotpSetupData } from "../types/auth.types";

export type {
  AuditLogQuery,
  EmailOtpRequest,
  EmailOtpVerifyRequest,
  MagicLinkRequest,
  MagicLinkVerifyRequest,
} from "../types/api.types";

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
  log_level: "infrastructure" | "application" | "unknown";
  severity: "critical" | "high" | "medium" | "low" | "info" | "unknown";
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
}

export interface DiagnosisResultsResponse {
  records: DiagnosisRecord[];
  total_count: number;
}

export interface DiagnosisQuery {
  record_ids?: string;
  telemetry_entry_id?: number;
  status?: string;
  source_category?: string;
  log_level?: "infrastructure" | "application" | "unknown";
  severity?: "critical" | "high" | "medium" | "low" | "info" | "unknown";
  limit?: number;
}

export interface DiagnosisFilterOptions {
  // Legacy local filter key kept for compatibility with older clients.
  agent_name?: string;
  // Preferred local filter key for diagnosis list environment search.
  environment?: string;
  date_from?: string;
  date_to?: string;
  sort_by: "id" | "status" | "created_at";
  sort_order: "asc" | "desc";
}

export type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT" | "CRITICAL";
export type TicketStatus =
  | "NEW"
  | "OPEN"
  | "PENDING"
  | "IN_PROGRESS"
  | "RESOLVED"
  | "CLOSED"
  | "CANCELLED";
export type ResolutionType = "FULLY_CLOSED" | "WORKAROUND" | "PARTIALLY_CLOSED";

export interface DiagnosisTicket {
  id: string;
  diagnosisId: number;
  telemetryEntryId: number;
  externalTicketId: string;
  externalTicketNumber: string;
  ticketProvider: string;
  ticketUrl: string | null;
  ticketStatus: TicketStatus;
  ticketPriority: TicketPriority;
  ticketCreatedAt: Date | string;
  ticketUpdatedAt: Date | string;
  ticketResolvedAt: Date | string | null;
  ruleDescription: string | null;
  ruleLevel: number | null;
  agentName: string | null;
  agentIp: string | null;
  stateTexts: string | null;
  diagnosisState: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface CreateTicketFromDiagnosisInput {
  diagnosisId: number;
  telemetryEntryId: number;
  priority?: TicketPriority;
  additionalNotes?: string;
  async?: boolean;
}

export interface ResolvedTicketsQuery {
  resolutionType?: ResolutionType[];
  priority?: TicketPriority[];
  provider?: string;
  hasLessonsLearned?: boolean;
  page?: number;
  limit?: number;
  sortBy?:
    | "ticketCreatedAt"
    | "ticketUpdatedAt"
    | "ticketResolvedAt"
    | "ticketPriority";
  sortOrder?: "asc" | "desc";
}

export interface ResolvedTicketDetails {
  id: string;
  diagnosisId: number;
  telemetryEntryId: number | null;
  externalTicketId: string;
  externalTicketNumber: string;
  ticketProvider: string;
  ticketUrl: string | null;
  ticketStatus: string;
  ticketPriority: TicketPriority;
  ticketCreatedAt: Date | string;
  ticketUpdatedAt: Date | string | null;
  ticketResolvedAt: Date | string | null;
  lastSyncedAt: Date | string | null;
  lastSyncError: string | null;
  resolutionType: ResolutionType | null;
  lessonsLearned: string | null;
  resolutionNotes: string | null;
  ruleDescription: string | null;
  agentName: string | null;
}

export interface PaginatedResolvedTickets {
  data: ResolvedTicketDetails[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ResolvedTicketsSummary {
  total: number;
  byResolutionType: Record<string, number>;
  avgResolutionTimeHours: number;
  withLessonsLearned: number;
}

export interface UpdateResolutionMetadataData {
  resolutionType?: ResolutionType;
  lessonsLearned?: string;
  resolutionNotes?: string;
}

export interface UpdateResolutionMetadataInput {
  id: string;
  data: UpdateResolutionMetadataData;
}

export interface SyncResolutionStatusesInput {
  provider?: "trello" | "jira" | "clickup";
  batchSize?: number;
}

export interface SyncResult {
  synced: number;
  failed: number;
  errors: Array<{ externalId: string; error: string }>;
  duration: number;
}

export interface ActivityTimelineQuery {
  limit?: number;
  type?: string;
}

export interface ActivityTimelineItem {
  id: string;
  type: string;
  description: string;
  severity?: string;
  timestamp: string;
}

export interface SecurityDomainTrend {
  value: number;
  date?: string;
}

export interface SecurityDomainMetric {
  domain: string;
  totalItems: number;
  resolved: number;
  trends?: SecurityDomainTrend[];
}

export interface ThreatAttackVector {
  name: string;
  count: number;
}

export interface ThreatSourceMetric {
  country: string;
  count: number;
  lat: number;
  lng: number;
}

export interface ThreatSeverityBreakdown {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ThreatIntelligenceMetrics {
  attackVectors: ThreatAttackVector[];
  threatSources: ThreatSourceMetric[];
  severityBreakdown?: ThreatSeverityBreakdown;
}

export interface UsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  role?: string;
}

export interface PaginatedUsers {
  data: User[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface AuditLogsResponse {
  data: AuditLog[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UpdateUserInput {
  id: string;
  data: {
    status?: { id: number };
    role?: { id: number };
  };
}

export interface AuditLogExportResponse {
  data: string;
  filename: string;
}

export interface PasskeyRecord {
  id: string;
  credentialId?: string;
  deviceName: string | null;
  transports?: string[];
  createdAt: string;
  lastUsedAt?: string;
  isActive: boolean;
}

export interface PasskeysResponse {
  passkeys: PasskeyRecord[];
  total: number;
  active: number;
}

export interface TotpEnableInput {
  token: string;
  secret: string;
}

export interface TotpEnableResponse {
  verified: boolean;
  message?: string;
}

export interface TotpStatusResponse {
  enabled: boolean;
  hasBackupCodes: boolean;
  remainingBackupCodes: number;
}

export interface PasskeyRegistrationOptionsResponse {
  registrationOptions: unknown;
  challengeId: string;
}

export interface PasskeyRegistrationVerifyInput {
  challengeId: string;
  response: unknown;
  deviceName: string;
}

export interface PasskeyRegistrationVerifyResponse {
  success: boolean;
  message?: string;
}

export interface PasskeyAuthenticationCredentialDescriptor {
  id: string;
  type: "public-key";
  transports?: Array<"ble" | "internal" | "nfc" | "usb">;
}

export interface PasskeyAuthenticationOptions {
  challenge: string;
  allowCredentials: PasskeyAuthenticationCredentialDescriptor[];
  userVerification: "required" | "preferred" | "discouraged";
  rpId: string;
  timeout?: number;
}

export interface PasskeyAuthenticationOptionsResponse {
  authenticationOptions?: PasskeyAuthenticationOptions;
  challengeId?: string;
  message?: string;
}

export interface PasskeyAuthenticationVerifyInput {
  challengeId: string;
  response: unknown;
}

export interface CurrentUser extends User {
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
  passkeyEnabled?: boolean;
}

export interface PasskeyAuthenticationVerifyResponse {
  success: boolean;
  message: string;
  token?: string;
  user?: CurrentUser;
}

export interface TotpFor2FAVerifyResponse {
  success?: boolean;
  verified?: boolean;
  token?: string;
  refreshToken?: string;
  rememberMeExpiryHours?: number;
  user?: CurrentUser;
  message?: string;
}

export interface SystemSettingsView extends GeneralSettingsDto {
  systemTimezone?: string;
}

export interface AuthSessionState {
  user: CurrentUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface DiagnosisServicePort {
  getDiagnosisResults(
    params?: DiagnosisQuery,
  ): Promise<DiagnosisResultsResponse>;
  getDiagnosisTickets(diagnosisIds?: number[]): Promise<DiagnosisTicket[]>;
  createDiagnosisTicket(
    input: CreateTicketFromDiagnosisInput,
  ): Promise<unknown>;
}

export interface TicketsServicePort {
  getResolvedTicket(id: string): Promise<ResolvedTicketDetails | null>;
  getResolvedTickets(
    filters?: ResolvedTicketsQuery,
  ): Promise<PaginatedResolvedTickets>;
  getResolvedSummary(): Promise<ResolvedTicketsSummary>;
  updateResolutionMetadata(
    input: UpdateResolutionMetadataInput,
  ): Promise<ResolvedTicketDetails>;
  syncResolutionStatuses(
    input?: SyncResolutionStatusesInput,
  ): Promise<SyncResult>;
  syncTicketStatus(id: string): Promise<ResolvedTicketDetails>;
}

export interface AnalyticsServicePort {
  getActivityTimeline(
    params?: ActivityTimelineQuery,
  ): Promise<ActivityTimelineItem[]>;
  getSecurityDomains(): Promise<SecurityDomainMetric[]>;
  getThreatIntelligence(): Promise<ThreatIntelligenceMetrics>;
  getRecentThreats(hours?: number): Promise<ThreatIntelligenceDto[]>;
}

export interface VulnerabilitiesServicePort {
  getVulnerabilityTimeline(id: string): Promise<VulnerabilityTimeline[]>;
}

export interface SettingsServicePort {
  getSystemSettings(): Promise<SystemSettingsView>;
  getSecuritySettings(): Promise<SecurityPolicyDto>;
  getIntegrationSettings(): Promise<AllSettingsDto>;
  updateSystemSettings(
    data: Partial<GeneralSettingsDto>,
  ): Promise<GeneralSettingsDto>;
  updateSecuritySettings(
    data: Partial<SecurityPolicyDto>,
  ): Promise<SecurityPolicyDto>;
  updateNotificationSettings(
    data: Partial<NotificationSettingsDto>,
  ): Promise<NotificationSettingsDto>;
}

export interface UsersServicePort {
  getUsers(params?: UsersQuery): Promise<PaginatedUsers>;
  updateUser(input: UpdateUserInput): Promise<User>;
}

export interface AuditLogsServicePort {
  getAuditLogs(params?: AuditLogQuery): Promise<AuditLogsResponse>;
  exportAuditLogs(params?: AuditLogQuery): Promise<AuditLogExportResponse>;
}

export interface AuthServicePort {
  getCurrentUser(): Promise<CurrentUser | null>;
  sendEmailOtp(input: EmailOtpRequest): Promise<EmailOtpResponse>;
  verifyEmailOtp(input: EmailOtpVerifyRequest): Promise<EmailOtpVerifyResponse>;
  sendMagicLink(input: MagicLinkRequest): Promise<MagicLinkResponse>;
  verifyMagicLink(
    input: MagicLinkVerifyRequest,
  ): Promise<MagicLinkVerifyResponse>;
  verifyTotpFor2FA(input: { token: string; tempToken: string }): Promise<TotpFor2FAVerifyResponse>;
  setupTotp(input: { password: string }): Promise<TotpSetupData>;
  enableTotp(input: TotpEnableInput): Promise<TotpEnableResponse>;
  getTotpStatus(): Promise<TotpStatusResponse>;
  generatePasskeyRegistrationOptions(input: {
    deviceName: string;
  }): Promise<PasskeyRegistrationOptionsResponse>;
  verifyPasskeyRegistration(
    input: PasskeyRegistrationVerifyInput,
  ): Promise<PasskeyRegistrationVerifyResponse>;
  generatePasskeyAuthenticationOptions(input: {
    email?: string;
  }): Promise<PasskeyAuthenticationOptionsResponse>;
  verifyPasskeyAuthentication(
    input: PasskeyAuthenticationVerifyInput,
  ): Promise<PasskeyAuthenticationVerifyResponse>;
  getPasskeys(): Promise<PasskeysResponse>;
  deletePasskey(input: {
    id: string;
  }): Promise<{ success?: boolean; message?: string }>;
}

export interface RuntimeServicePort {
  getAuthSession(): AuthSessionState;
  logout(): Promise<void> | void;
  navigate(path: string): void;
  getConnectionStatus(): boolean;
}

export type LogLevelThreshold = "error" | "warning" | "info" | "debug";

export type ErrorSourceType = "sentry" | "wazuh" | "posthog";

export interface ErrorSourceRow {
  id: string;
  sourceType: ErrorSourceType;
  name: string;
  syncEnabled: boolean;
  autoDiagnosisEnabled: boolean;
  logLevelThreshold: LogLevelThreshold;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  configuration?: Record<string, unknown>;
}

export interface CreateErrorSourceInput {
  sourceType: ErrorSourceType;
  name: string;
  authToken?: string;
  organizationSlug?: string;
  organizationId?: string;
  projectSlugs?: string[];
  projectIds?: string[];
  baseUrl?: string;
  indexPatterns?: string[];
  logLevelThreshold: LogLevelThreshold;
  syncEnabled: boolean;
  autoDiagnosisEnabled: boolean;
}

export interface UpdateErrorSourceInput {
  id: string;
  name?: string;
  logLevelThreshold?: LogLevelThreshold;
  syncEnabled?: boolean;
  autoDiagnosisEnabled?: boolean;
}

export interface ErrorSourceSyncResult {
  sourceId: string;
  syncedIssues: number;
  syncedEvents: number;
  error?: string;
}

export interface ErrorSourcesServicePort {
  getAll(): Promise<ErrorSourceRow[]>;
  create(input: CreateErrorSourceInput): Promise<ErrorSourceRow>;
  update(input: UpdateErrorSourceInput): Promise<void>;
  delete(id: string): Promise<void>;
  sync(
    id: string,
    options: { logLevelThreshold: LogLevelThreshold; syncEnabled: boolean },
  ): Promise<ErrorSourceSyncResult>;
}

export type RunbookActionType =
  | "shell"
  | "llm"
  | "http"
  | "external_source"
  | "telemetry_existing_entry"
  | "data_source_query"
  | "telemetry_ingest"
  | "diagnosis_diagnose"
  | "diagnosis_verify"
  | "diagnosis_recommend";
export type RunbookHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RunbookLlmProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor";

export interface RunbookHttpHeader {
  key: string;
  value: string;
}

export interface RunbookActionParameter {
  id: string;
  key: string;
  label?: string;
  description?: string;
  defaultValue?: string;
  required?: boolean;
  secure?: boolean;
}

export interface LogFilterConfig {
  type?: "regex";
  pattern: string;
  flags?: string;
  multiline?: boolean;
  match?: "first" | "all";
  maxMatches?: number;
}

export interface TelemetryNeedOption {
  id: string;
  label: string;
  description?: string;
}

export type RunbookTriggerSurface =
  | "runbooks"
  | "incident_detail"
  | "incident_workspace"
  | "diagnosis";

export interface RunbookTriggerContext {
  needId?: string;
  needLabel?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: "sentry" | "wazuh" | "posthog";
  entrypoint: RunbookTriggerSurface;
  incidentThreadId?: string;
}

export interface TelemetryActionConfig {
  needId?: string;
  needLabel?: string;
  sourceId?: string;
  sourceType?: "sentry" | "wazuh" | "posthog";
  sourceName?: string;
  queryMode?: "search" | "collector";
  queryLimit?: number;
  queryText?: string;
  collectionDate?: string;
  include?: string;
  exclude?: string;
  indexPattern?: string;
  telemetryEntryIds?: number[];
  diagnosisEntryIds?: number[];
  llmProviderKey?: RunbookLlmProviderKey;
  llmModel?: string;
  entrypoint?: RunbookTriggerSurface;
}

export type RunbookParameterValues = Record<string, string>;

export interface RunbookActionRecord {
  id: string;
  type: RunbookActionType;
  title: string;
  command?: string;
  prompt?: string;
  llmProviderKey?: RunbookLlmProviderKey;
  llmModel?: string;
  url?: string;
  method?: RunbookHttpMethod;
  headers?: RunbookHttpHeader[];
  body?: string;
  query?: string;
  sourceId?: string;
  parameters?: RunbookActionParameter[];
  logFilter?: LogFilterConfig;
  telemetryConfig?: TelemetryActionConfig;
}

export interface RunbookRecord {
  id: string;
  title: string;
  description: string;
  idleTimeout?: number;
  revisionNumber: number;
  actions: RunbookActionRecord[];
  createdAt: string;
  updatedAt: string;
}

export type RunbookAuthoringProposalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "revision_requested";

export type RunbookAuthoringProposalKind =
  | "edit_existing_runbook"
  | "create_new_runbook";

export interface RunbookAuthoringProposalReview {
  status: RunbookAuthoringProposalStatus;
  approvalRequired: boolean;
  saved: boolean;
  proposalId: string;
  kind: RunbookAuthoringProposalKind;
  incidentThreadId?: string;
  targetRunbookId?: string;
  targetRevisionNumber?: number;
  proposedRunbook: {
    id: string;
    title: string;
    description: string;
    revisionNumber: number;
    actionCount: number;
    actions: Array<{
      id: string;
      type: string;
      title: string;
    }>;
  };
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
  operationDiffs: Array<{
    operationId: string;
    type: string;
    rationale: string;
    riskLabels: string[];
    before: unknown;
    after: unknown;
  }>;
  nextStep: string;
}

export interface RunbookAuthoringProposalDecisionResult {
  proposal: RunbookAuthoringProposalReview;
  savedRunbook?: RunbookRecord;
  approvedOperationIds?: string[];
  reason?: string;
  requestedEdit?: string;
}

export interface RunbookContextV1 {
  format: "bitsentry.runbook.context";
  version: 1;
  runbook: {
    id: string;
    title: string;
    description: string;
    revisionNumber: number;
    updatedAt: string;
    actionCount: number;
  };
  summary: {
    purposeText: string;
    actionTypeCounts: Record<RunbookActionType, number>;
    orderedActionTitles: string[];
  };
  globalReferences?: Array<{
    key: string;
    secure?: boolean;
    description?: string;
  }>;
  actions: Array<{
    id: string;
    order: number;
    type: RunbookActionType;
    title: string;
    payload: {
      command?: string;
      prompt?: string;
      llmProviderKey?: RunbookLlmProviderKey;
      llmModel?: string;
      url?: string;
      method?: RunbookHttpMethod;
      headers?: RunbookHttpHeader[];
      body?: string;
      query?: string;
      sourceId?: string;
      parameters?: RunbookActionParameter[];
      logFilter?: LogFilterConfig;
      telemetryConfig?: TelemetryActionConfig;
    };
  }>;
  executionContext?: RunbookTriggerContext;
}

export type RunbookExecutionStatus =
  | "queued"
  | "pending"
  | "running"
  | "claim_expired"
  | "completed"
  | "failed"
  | "cancelled";
export type RunbookExecutionSource = "manual" | "agent";
export type RunbookExecutionCompletionReason =
  | "success"
  | "step_failed"
  | "user_cancelled"
  | "idle_timeout"
  | "app_shutdown"
  | "lease_expired";

export type RunbookExecutionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunbookExecutionStepRecord {
  actionId: string;
  order: number;
  type: RunbookActionType;
  title: string;
  status: RunbookExecutionStepStatus;
  input?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  statusCode?: number;
  streamDeltas?: Array<{
    timestamp: string;
    text: string;
    kind?: "text" | "command_output";
  }>;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

export type GlobalVariableScope =
  | { product: "superterminal"; owner: "local_app" }
  | { product: "dashboard"; owner: "user"; userId: string };

export interface GlobalVariable {
  id: string;
  key: string;
  value?: string;
  valueRef?: string;
  description?: string;
  secure?: boolean;
  scope: GlobalVariableScope;
  createdAt: string;
  updatedAt: string;
}

export interface GlobalVariableInput {
  key: string;
  value?: string;
  valueRef?: string;
  description?: string;
  secure?: boolean;
}

export interface GlobalVariablePatch {
  key?: string;
  value?: string;
  valueRef?: string;
  description?: string;
  secure?: boolean;
}

export interface GlobalVariablesServicePort {
  list(): Promise<GlobalVariable[]>;
  create(input: GlobalVariableInput): Promise<GlobalVariable>;
  update(
    id: string,
    patch: GlobalVariablePatch,
  ): Promise<GlobalVariable | null>;
  delete(id: string): Promise<{ deleted: boolean }>;
}

export interface RunbookExportedBy {
  product: "superterminal" | "dashboard";
  runtime: "desktop" | "backend";
  appVersion?: string;
}

export interface ExportedRunbookActionV1 {
  id?: string;
  type: RunbookActionType;
  title: string;
  command?: string;
  prompt?: string;
  llmProviderKey?: RunbookLlmProviderKey;
  llmModel?: string;
  url?: string;
  method?: RunbookHttpMethod;
  headers?: RunbookHttpHeader[];
  body?: string;
  query?: string;
  sourceId?: string;
  parameters?: RunbookActionParameter[];
  timeout?: number;
  logFilter?: LogFilterConfig;
  telemetryConfig?: TelemetryActionConfig;
}

export interface ExportedRunbookV1 {
  id?: string;
  title: string;
  description?: string;
  idleTimeout?: number;
  revisionNumber?: number;
  actions: ExportedRunbookActionV1[];
  tags?: string[];
}

export interface ExportedGlobalVariableV1 {
  key: string;
  value?: string;
  description?: string;
  secure?: boolean;
  redacted?: boolean;
}

export interface RunbookExportArtifactV1 {
  format: "bitsentry.runbooks.export";
  version: 1;
  exportedAt: string;
  exportedBy?: RunbookExportedBy;
  runbooks: ExportedRunbookV1[];
  globals?: ExportedGlobalVariableV1[];
}

export interface RunbookImportOptions {
  conflictPolicy?: "duplicate" | "skip" | "overwrite";
  preserveIds?: boolean;
  includeGlobals?: boolean;
  dryRun?: boolean;
}

export interface RunbookImportResult {
  title: string;
  status: "imported" | "skipped" | "failed";
  runbookId?: string;
  reason?: string;
  warnings?: string[];
}

export interface RunbookImportSummary {
  imported: number;
  skipped: number;
  failed: number;
  warnings: string[];
  results: RunbookImportResult[];
}

export interface RunbookExecutionRecord {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string | null;
  runbookTitle: string;
  status: RunbookExecutionStatus;
  snapshotVersion?: number;
  startedAt: string;
  completedAt?: string;
  completionReason?: RunbookExecutionCompletionReason;
  idleTimeoutMinutes?: number;
  lastActivityAt?: string;
  parameterValues?: RunbookParameterValues;
  source?: RunbookExecutionSource;
  triggerContext?: RunbookTriggerContext;
  steps: RunbookExecutionStepRecord[];
}

export interface RunbookExecutionSummaryRecord {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string | null;
  runbookTitle: string;
  status: RunbookExecutionStatus;
  snapshotVersion?: number;
  startedAt: string;
  completedAt?: string;
  completionReason?: RunbookExecutionCompletionReason;
  idleTimeoutMinutes?: number;
  lastActivityAt?: string;
  stepCount: number;
  completedStepCount: number;
  source?: RunbookExecutionSource;
  triggerContext?: RunbookTriggerContext;
  currentActionLabel?: string;
  providerUsed?: RunbookLlmProviderKey;
  modelUsed?: string;
  failureReason?: string;
  telemetryEntryIds?: number[];
  diagnosisEntryIds?: number[];
}

export interface RunbookResultRecord {
  id: string;
  executionId?: string;
  runbookId: string;
  incidentThreadId?: string;
  runbookTitle: string;
  runbookRevisionNumber?: number;
  runbookContextJson?: string;
  status: RunbookExecutionStatus;
  startedAt: string;
  completedAt?: string;
  completionReason?: RunbookExecutionCompletionReason;
}

export interface RunbooksServicePort {
  list(): Promise<RunbookRecord[]>;
  get(id: string): Promise<RunbookRecord | null>;
  create(input: {
    title: string;
    description: string;
    idleTimeout?: number;
    actions?: Omit<RunbookActionRecord, "id">[];
  }): Promise<RunbookRecord>;
  updateMetadata(
    id: string,
    metadata: { title?: string; description?: string; idleTimeout?: number },
  ): Promise<RunbookRecord | null>;
  updateActions(
    id: string,
    actions: Omit<RunbookActionRecord, "id">[],
  ): Promise<RunbookRecord | null>;
  saveAction(
    id: string,
    action: RunbookActionRecord,
    sortOrder?: number,
  ): Promise<RunbookRecord | null>;
  deleteAction(id: string, actionId: string): Promise<RunbookRecord | null>;
  reorderActions(
    id: string,
    actionIdsInOrder: string[],
  ): Promise<RunbookRecord | null>;
  delete(id: string): Promise<{ deleted: boolean }>;
  exportContext(id: string): Promise<RunbookContextV1>;
  exportRunbooks(input: {
    ids: string[];
    includeGlobals?: boolean;
  }): Promise<RunbookExportArtifactV1>;
  importRunbooks(input: {
    artifact: RunbookExportArtifactV1;
    options?: RunbookImportOptions;
  }): Promise<RunbookImportSummary>;
  listTelemetryNeeds(): Promise<TelemetryNeedOption[]>;
  execute(input: {
    runbookId: string;
    parameterValues?: RunbookParameterValues;
    incidentThreadId?: string;
    triggerContext?: RunbookTriggerContext;
  }): Promise<{ executionId: string; resultId: string }>;
  continueDiagnosis(input: {
    diagnosisId: number;
    telemetryEntryId?: number;
    sourceId?: string;
    incidentThreadId?: string;
    llmProviderKey?: RunbookLlmProviderKey;
    llmModel?: string;
  }): Promise<{ executionId: string; resultId: string }>;
  getExecution(executionId: string): Promise<RunbookExecutionRecord | null>;
  listExecutions(filters?: {
    status?: RunbookExecutionStatus;
    limit?: number;
    offset?: number;
    runbookId?: string;
  }): Promise<{
    executions: RunbookExecutionSummaryRecord[];
    total: number;
    hasMore: boolean;
  }>;
  listTelemetryActivity(filters?: {
    status?: RunbookExecutionStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    executions: RunbookExecutionSummaryRecord[];
    total: number;
    hasMore: boolean;
  }>;
  getLinkedTelemetryExecution(input: {
    diagnosisId?: number;
    telemetryEntryId?: number;
  }): Promise<RunbookExecutionSummaryRecord | null>;
  cancelExecution(executionId: string): Promise<{ cancelled: boolean }>;
  onExecutionEvent(
    handler: (data: {
      resultId: string;
      executionId: string;
      incidentThreadId?: string | null;
      execution: RunbookExecutionRecord;
    }) => void,
  ): () => void;
}

export type AgentEvent =
  | { type: "assistant_delta"; delta: string; timestamp: string }
  | {
      type: "token_usage";
      timestamp: string;
      tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        contextTokens?: number;
        contextLimit?: number;
      };
    }
  | { type: "thinking_start"; timestamp: string }
  | { type: "thinking_delta"; delta: string; timestamp: string }
  | { type: "thinking_end"; timestamp: string }
  | {
      type: "tool_start";
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      timestamp: string;
    }
  | {
      type: "tool_update";
      toolCallId: string;
      chunk: string;
      truncationWarning?: boolean;
      timestamp: string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      state: string;
      output?: string;
      modelContext?: string;
      artifactId?: string;
      error?: string;
      timestamp: string;
    }
  | {
      type: "final";
      response: string;
      timestamp: string;
      tokenUsage?: {
        inputTokens: number;
        outputTokens: number;
        contextTokens?: number;
        contextLimit?: number;
      };
    }
  | { type: "cancelled"; message: string; timestamp: string }
  | {
      type: "error";
      message: string;
      code?: "NO_LLM_PROVIDER_CONFIGURED";
      level?: "error" | "warning";
      timestamp: string;
    };

export interface AgentChatAttachment {
  id: string;
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface AgentLlmSelection {
  providerKey?:
    | "groq"
    | "kilocode"
    | "openai"
    | "anthropic"
    | "gemini"
    | "openrouter"
    | "claude_code"
    | "codex"
    | "opencode"
    | "cursor";
  model?: string;
  thinkingEnabled?: boolean;
}

export interface AgentRunbookContext {
  id: string;
  title: string;
  description: string;
  actions: Array<{
    id: string;
    type: string;
    title: string;
    command?: string;
    prompt?: string;
    llmProviderKey?: RunbookLlmProviderKey;
    llmModel?: string;
    url?: string;
    method?: string;
    headers?: RunbookHttpHeader[];
    query?: string;
    body?: string;
    parameters?: RunbookActionParameter[];
    logFilter?: LogFilterConfig;
  }>;
}

export interface AgentStartRequest {
  prompt: string;
  timeoutMs?: number;
  attachments?: AgentChatAttachment[];
  llm?: AgentLlmSelection;
  runbookId?: string;
  incidentThreadId?: string;
  accessLevel?: AccessLevel;
  interactionMode?: InteractionMode;
  traitValues?: Record<string, string | boolean>;
}

export interface AgentSendRequest {
  message: string;
  sessionId?: string;
  attachments?: AgentChatAttachment[];
  llm?: AgentLlmSelection;
  runbookId?: string;
  incidentThreadId?: string;
  accessLevel?: AccessLevel;
  interactionMode?: InteractionMode;
  traitValues?: Record<string, string | boolean>;
}

export interface AgentSessionStatus {
  sessionId: string;
  state: "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  startedAt: string;
  currentToolCallId: string | null;
}

export interface AgentServicePort {
  start(input: AgentStartRequest): Promise<{ sessionId: string }>;
  send(input: AgentSendRequest): Promise<{ sessionId: string }>;
  cancel(sessionId: string): Promise<void>;
  getStatus(sessionId: string): Promise<AgentSessionStatus | null>;
  getSnapshot(sessionId: string): Promise<AgentThreadSnapshot | null>;
  listRunbookAuthoringProposals(input: {
    sessionId?: string;
    incidentThreadId?: string;
  }): Promise<RunbookAuthoringProposalReview[]>;
  approveRunbookAuthoringProposal(input: {
    sessionId?: string;
    incidentThreadId?: string;
    proposalId: string;
    approvedOperationIds?: string[];
  }): Promise<RunbookAuthoringProposalDecisionResult>;
  rejectRunbookAuthoringProposal(input: {
    sessionId?: string;
    incidentThreadId?: string;
    proposalId: string;
    reason?: string;
  }): Promise<RunbookAuthoringProposalDecisionResult>;
  requestRunbookAuthoringRevision(input: {
    sessionId?: string;
    incidentThreadId?: string;
    proposalId: string;
    requestedEdit: string;
  }): Promise<RunbookAuthoringProposalDecisionResult>;
  onEvent(
    handler: (data: {
      sessionId: string;
      event: AgentEvent;
      // Desktop includes a projected snapshot with each event, while the
      // dashboard websocket transport only emits the raw agent event.
      snapshot?: AgentThreadSnapshot;
    }) => void,
  ): () => void;
}

// LLM Provider Types
export type ProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor";
export type ProviderType = "research_lab" | "third_party" | "self_hosted";

export interface LLMProviderDto {
  id: string;
  providerKey: ProviderKey;
  displayName: string;
  providerType: ProviderType;
  baseUrl: string;
  hasApiKey: boolean;
  model: string | null;
  availableModels: string[];
  isPrimary: boolean;
  isSelectable: boolean;
  lastTestedAt: string | null;
  testStatus: "success" | "error" | null;
  createdAt: string;
  updatedAt: string;
}

export interface SaveProviderRequest {
  providerKey: ProviderKey;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  availableModels?: string[];
  isPrimary?: boolean;
}

export interface ListModelsRequest {
  providerKey: ProviderKey;
  apiKey?: string;
  baseUrl?: string;
}

export interface ListModelsResponse {
  providerKey: ProviderKey;
  models: string[];
  count: number;
  fetchedAt: string;
}

export interface TestConnectionRequest {
  providerKey: ProviderKey;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  requestId?: string;
}

export interface TestConnectionResponse {
  ok: boolean;
  message: string;
  latencyMs: number;
  responseText: string;
  requestId: string;
}

export interface LLMProviderServicePort {
  /**
   * List all LLM provider configurations (global-scoped).
   */
  listProviders(): Promise<LLMProviderDto[]>;

  /**
   * Save or update a provider configuration.
   * Admin only. API key is encrypted at rest and never returned.
   */
  saveProvider(request: SaveProviderRequest): Promise<LLMProviderDto>;

  /**
   * Set a provider as the primary/default for the organization.
   * Admin only.
   */
  setPrimaryProvider(providerId: string): Promise<LLMProviderDto[]>;

  /**
   * Fetch available models from a provider's API.
   * Admin only.
   */
  listModels(request: ListModelsRequest): Promise<ListModelsResponse>;

  /**
   * Test connectivity to a provider's API.
   * Admin only.
   */
  testConnection(
    request: TestConnectionRequest,
  ): Promise<TestConnectionResponse>;

  /**
   * Delete a provider configuration.
   * Admin only. Cannot delete primary provider.
   */
  deleteProvider(providerId: string): Promise<{ deleted: boolean }>;
}

// ── Incident Types ───────────────────────────────────────────────────────────────

export type IncidentThreadState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type IncidentMessageKind = "user" | "assistant" | "system" | "tool";

export type IncidentMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error";

export type IncidentAttachmentType = "image";

export interface IncidentAttachment {
  id: string;
  type: IncidentAttachmentType;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl?: string; // Optional - not stored in DB for efficiency
}

export interface IncidentToolCall {
  toolCallId: string;
  toolName: string;
  state: "running" | "done" | "failed";
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

export interface IncidentThreadDto {
  id: string;
  title: string;
  prompt: string;
  state: IncidentThreadState;
  runbookId?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  lastMessagePreview?: string | null;
  messageCount?: number;
}

export interface IncidentMessageDto {
  id: string;
  threadId: string;
  sortOrder: number;
  kind: IncidentMessageKind;
  text: string | null;
  streamText: string | null;
  finalText: string | null;
  status: IncidentMessageStatus | null;
  errorMsg: string | null;
  toolCalls: IncidentToolCall[];
  attachments: IncidentAttachment[];
  createdAt: string;
  updatedAt: string;
}

export interface IncidentsServicePort {
  /**
   * List all incident threads for the current user.
   */
  listThreads(options?: {
    state?: IncidentThreadState;
    includeArchived?: boolean;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<{ threads: IncidentThreadDto[]; total: number }>;

  /**
   * Get a thread with its messages.
   */
  getThreadDetail(threadId: string): Promise<{
    thread: IncidentThreadDto;
    messages: IncidentMessageDto[];
  } | null>;

  /**
   * Create a new incident thread.
   */
  createThread(input: {
    title?: string;
    prompt: string;
    runbookId?: string;
  }): Promise<IncidentThreadDto>;

  /**
   * Update thread title or state.
   */
  updateThread(input: {
    threadId: string;
    title?: string;
    state?: IncidentThreadState;
    runbookId?: string | null;
  }): Promise<IncidentThreadDto | null>;

  /**
   * Archive a thread.
   */
  archiveThread(threadId: string): Promise<{ archived: boolean }>;

  /**
   * Restore a previously archived thread.
   */
  unarchiveThread(threadId: string): Promise<{ archived: boolean }>;

  /**
   * Append a message to a thread.
   */
  appendMessage(input: {
    threadId: string;
    message: Omit<
      IncidentMessageDto,
      "id" | "threadId" | "createdAt" | "updatedAt"
    >;
  }): Promise<IncidentMessageDto>;

  /**
   * Update a message (used for streaming).
   */
  updateMessage(
    messageId: string,
    updates: Partial<
      Omit<IncidentMessageDto, "id" | "threadId" | "createdAt" | "updatedAt">
    >,
  ): Promise<IncidentMessageDto | null>;
}

export interface BitsentryServicePorts {
  diagnosis?: DiagnosisServicePort;
  tickets?: TicketsServicePort;
  analytics?: AnalyticsServicePort;
  vulnerabilities?: VulnerabilitiesServicePort;
  settings?: SettingsServicePort;
  globalVariables?: GlobalVariablesServicePort;
  users?: UsersServicePort;
  auditLogs?: AuditLogsServicePort;
  auth?: AuthServicePort;
  runtime?: RuntimeServicePort;
  errorSources?: ErrorSourcesServicePort;
  runbooks: RunbooksServicePort;
  agent?: AgentServicePort;
  llmProviders?: LLMProviderServicePort;
  incidents?: IncidentsServicePort;
}
