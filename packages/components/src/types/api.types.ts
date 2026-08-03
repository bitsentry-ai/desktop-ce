// Common types
export interface PaginationResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiResponse<T> {
  data: T;
  message?: string;
}

// Enums matching backend
export enum AgentType {
  ENDPOINT = "ENDPOINT",
  NETWORK = "NETWORK",
  CLOUD = "CLOUD",
  CONTAINER = "CONTAINER",
  API = "API",
}

export enum AgentStatus {
  ONLINE = "ONLINE",
  OFFLINE = "OFFLINE",
  ERROR = "ERROR",
  MAINTENANCE = "MAINTENANCE",
  UNKNOWN = "UNKNOWN",
}

export enum VulnerabilitySeverity {
  CRITICAL = "CRITICAL",
  HIGH = "HIGH",
  MEDIUM = "MEDIUM",
  LOW = "LOW",
  INFO = "INFO",
}

export enum VulnerabilityType {
  SAST = "SAST",
  DAST = "DAST",
  SCA = "SCA",
  IAST = "IAST",
  MANUAL = "MANUAL",
  PENETRATION_TEST = "PENETRATION_TEST",
}

export enum VulnerabilityStatus {
  OPEN = "OPEN",
  IN_PROGRESS = "IN_PROGRESS",
  RESOLVED = "RESOLVED",
  FALSE_POSITIVE = "FALSE_POSITIVE",
  ACCEPTED_RISK = "ACCEPTED_RISK",
}

// User types
export interface User {
  id: number;
  firstName?: string;
  lastName?: string;
  email: string;
  role?: {
    id: number;
    name: string;
  };
  status?: {
    id: number;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CurrentUser extends User {
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
  passkeyEnabled?: boolean;
}

// Auth types
export interface LoginRequest {
  email: string;
  password: string;
  rememberMe?: boolean;
}

export interface RegisterRequest {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  tokenExpires: number;
  user: CurrentUser;
  rememberMeExpiryHours?: number;
}

export interface RefreshResponse {
  token: string;
  refreshToken?: string;
  tokenExpires: number;
}

// Forgot Password types
export interface ForgotPasswordRequest {
  email: string;
}

export interface ForgotPasswordResponse {
  message: string;
}

export interface ResetPasswordRequest {
  token: string;
  newPassword: string;
}

export interface ResetPasswordResponse {
  message: string;
}

// Magic Link types
export interface MagicLinkRequest {
  email: string;
}

export interface MagicLinkResponse {
  success: boolean;
  message: string;
  expiresInSeconds?: number;
}

export interface MagicLinkVerifyRequest {
  token: string;
}

export interface MagicLinkVerifyResponse {
  token: string;
  refreshToken: string;
  tokenExpires: number;
  user: User;
  rememberMeExpiryHours?: number;
}

// Email OTP types
export interface EmailOtpRequest {
  email: string;
}

export interface EmailOtpResponse {
  success: boolean;
  message: string;
  otpId?: string;
  expiresAt?: string;
}

export interface EmailOtpVerifyRequest {
  email: string;
  otp: string;
}

export interface EmailOtpVerifyResponse {
  success: boolean;
  message: string;
  token?: string;
  requiresPassword?: boolean;
  user?: User;
}

// Agent types
export interface AgentTag {
  id: string;
  key: string;
  value: string;
  createdAt: string;
}

export interface AgentHealth {
  id: string;
  agentId: string;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  networkIn?: number;
  networkOut?: number;
  uptime?: number;
  errors?: Record<string, unknown>;
  warnings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  type: AgentType;
  status: AgentStatus;
  version: string;
  hostname?: string;
  ipAddress?: string;
  operatingSystem?: string;
  configuration?: Record<string, unknown>;
  capabilities: string[];
  lastHeartbeat?: string;
  lastSeen?: string;
  createdAt: string;
  updatedAt: string;
  health?: AgentHealth;
  tags?: AgentTag[];
}

export interface CreateAgent {
  name: string;
  description?: string;
  type: AgentType;
  version: string;
  hostname?: string;
  ipAddress?: string;
  operatingSystem?: string;
  configuration?: Record<string, unknown>;
  capabilities: string[];
}

export interface UpdateAgent {
  name?: string;
  description?: string;
  type?: AgentType;
  status?: AgentStatus;
  version?: string;
  hostname?: string;
  ipAddress?: string;
  operatingSystem?: string;
  configuration?: Record<string, unknown>;
  capabilities?: string[];
}

export interface AgentQuery {
  type?: AgentType;
  status?: AgentStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export interface AgentHeartbeat {
  agentId: string;
  health?: {
    cpuUsage?: number;
    memoryUsage?: number;
    diskUsage?: number;
    networkIn?: number;
    networkOut?: number;
    uptime?: number;
    errors?: Record<string, unknown>;
    warnings?: Record<string, unknown>;
  };
}

// Vulnerability types
export interface VulnerabilityTimeline {
  id: string;
  action: string;
  oldValue?: string;
  newValue?: string;
  user?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  createdAt: string;
}

export interface Vulnerability {
  id: string;
  title: string;
  description: string;
  severity: VulnerabilitySeverity;
  type: VulnerabilityType;
  status: VulnerabilityStatus;
  cvss?: number;
  cve?: string;
  cwe?: string;
  component?: string;
  version?: string;
  fixVersion?: string;
  recommendation?: string;
  falsePositive: boolean;
  fpJustification?: string;
  assignedToId?: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  // External ticket integration fields (provider-agnostic)
  externalTicketId?: string;
  externalTicketNumber?: string;
  ticketProvider?: string;
  ticketUrl?: string;
  ticketStatus?: string;
  name?: string; // Alias for title
  assignedTo?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  agents?: {
    id: string;
    name: string;
    hostname?: string;
    ipAddress?: string;
  }[];
  timeline?: VulnerabilityTimeline[];
}

export interface VulnerabilityQuery {
  severity?: VulnerabilitySeverity;
  type?: VulnerabilityType;
  status?: VulnerabilityStatus;
  search?: string;
  assignedToId?: number;
  agentId?: string;
  createdAfter?: string;
  createdBefore?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  hasTicket?: boolean;
}

export interface VulnerabilityStats {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  open: number;
  inProgress: number;
  resolved: number;
  falsePositive: number;
  acceptedRisk: number;
}

export interface UpdateVulnerabilityStatus {
  status: VulnerabilityStatus;
  comment?: string;
}

export interface AssignVulnerability {
  assignedToId: number;
  comment?: string;
}

export interface MarkFalsePositive {
  justification: string;
}

export interface BulkUpdateVulnerabilities {
  vulnerabilityIds: string[];
  status?: VulnerabilityStatus;
  assignedToId?: number;
  comment?: string;
}

// Analytics types
export interface TrendData {
  value: number;
  percentage: number;
  isPositive: boolean;
}

export interface SecurityOverview {
  totalAgents: number;
  onlineAgents: number;
  offlineAgents: number;
  totalVulnerabilities: number;
  criticalVulnerabilities: number;
  highVulnerabilities: number;
  mediumVulnerabilities: number;
  lowVulnerabilities: number;
  resolvedVulnerabilities: number;
  openVulnerabilities: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
  runningScans: number;
  threatIntelCount: number;
  activeThreatCount: number;
  agentHealthScore: number;
  securityScore: number;
  criticalVulnerabilitiesTrend?: TrendData;
  openVulnerabilitiesTrend?: TrendData;
  complianceScoreTrend?: TrendData;
  updatedAt?: string;
}

export interface TimeSeriesData {
  timestamp: string;
  value: number;
  label?: string;
}

export interface TimeSeriesQuery {
  metric?: string;
  interval?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface ActivityTimeline {
  id: string;
  type: string;
  description: string;
  severity?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  user?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  agent?: {
    id: string;
    name: string;
    hostname?: string;
  };
  vulnerability?: {
    id: string;
    title: string;
    severity: string;
  };
}

export interface ActivityQuery {
  type?: string;
  severity?: string;
  userId?: number;
  agentId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface SecurityDomainStats {
  domain: string;
  totalItems: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  resolved: number;
  trends: TimeSeriesData[];
}

export interface ThreatTrend {
  period: string;
  threats: number;
  vulnerabilities: number;
  incidents: number;
  resolved: number;
}

export interface MetricWidget {
  id: string;
  title: string;
  type: string;
  value: number;
  previousValue?: number;
  target?: number;
  unit?: string;
  trend?: "up" | "down" | "stable";
  data: TimeSeriesData[];
  color?: string;
  description?: string;
}

export interface DashboardConfig {
  widgets: MetricWidget[];
  refreshInterval: number;
  lastUpdated: string;
}

export interface MetricsQuery {
  category?: string;
  timeframe?: string;
  compareWith?: string;
}

export interface AgentHealthMetrics {
  agentId: string;
  name: string;
  status: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  uptime: number;
  lastHeartbeat: string;
  healthScore: number;
}

// Missing API types that need to be implemented

// Notifications
type NotificationType = "info" | "warning" | "error" | "success";
type TicketSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type TicketStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | "REJECTED";
type TicketPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type TicketType = "BUG" | "FEATURE" | "SUPPORT" | "SECURITY" | "INCIDENT";

export interface Notification {
  id: string;
  title: string;
  message: string;
  type: NotificationType;
  severity: TicketSeverity;
  read: boolean;
  userId: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationQuery {
  type?:
    | "VULNERABILITY"
    | "COMPLIANCE"
    | "THREAT"
    | "SCAN"
    | "AGENT"
    | "SYSTEM";
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  read?: boolean;
  page?: number;
  limit?: number;
  search?: string;
  startDate?: string;
  endDate?: string;
}

export interface CreateNotification {
  title: string;
  message: string;
  type: "info" | "warning" | "error" | "success";
  severity: TicketSeverity;
  userId: number;
  metadata?: Record<string, unknown>;
}

// Threat Intelligence
export interface ThreatIntelligence {
  id: string;
  title: string;
  description: string;
  severity: TicketSeverity;
  source: string;
  indicators: string[];
  affectedSystems: string[];
  recommendations: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

type ThreatType = "MALWARE" | "PHISHING" | "VULNERABILITY" | "EXPLOIT" | "IOC" | "TTPs";

export interface ThreatQuery {
  type?: ThreatType;
  severity?: TicketSeverity;
  source?: string;
  active?: boolean;
  search?: string;
  createdAfter?: string;
  createdBefore?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export type Threat = ThreatIntelligence;

export interface CreateThreat {
  title: string;
  description: string;
  severity: TicketSeverity;
  source: string;
  indicators: string[];
  affectedSystems: string[];
  recommendations: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateThreat {
  title?: string;
  description?: string;
  severity?: TicketSeverity;
  source?: string;
  indicators?: string[];
  affectedSystems?: string[];
  recommendations?: string[];
  metadata?: Record<string, unknown>;
}

// Reports
export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  type:
    | "VULNERABILITY"
    | "COMPLIANCE"
    | "THREAT"
    | "EXECUTIVE"
    | "TECHNICAL"
    | "CUSTOM";
  format: "PDF" | "CSV" | "JSON" | "HTML";
  parameters: Record<string, unknown>;
  createdAt: string;
}

export interface Report {
  id: string;
  templateId: string;
  name: string;
  status: "PENDING" | "GENERATING" | "COMPLETED" | "FAILED";
  format: string;
  parameters: Record<string, unknown>;
  filePath?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ScheduledReport {
  id: string;
  templateId: string;
  name: string;
  schedule: string; // cron expression
  enabled: boolean;
  lastRun?: string;
  nextRun: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

export interface GenerateReportRequest {
  templateId: string;
  parameters: Record<string, unknown>;
  format?: string;
}

export interface ReportQuery {
  status?: "PENDING" | "GENERATING" | "COMPLETED" | "FAILED";
  templateId?: string;
  format?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface CreateReport {
  templateId: string;
  name: string;
  format: "PDF" | "CSV" | "JSON" | "HTML";
  parameters: Record<string, unknown>;
}

// Integrations
export enum IntegrationType {
  SONARQUBE = "SONARQUBE",
  OWASP_ZAP = "OWASP_ZAP",
  DEPENDENCY_CHECK = "DEPENDENCY_CHECK",
  METASPLOIT = "METASPLOIT",
  TESTSSL = "TESTSSL",
  SIEM = "SIEM",
  SOAR = "SOAR",
  SLACK = "SLACK",
  EMAIL = "EMAIL",
}

export enum IntegrationStatus {
  ACTIVE = "ACTIVE",
  INACTIVE = "INACTIVE",
  ERROR = "ERROR",
  MAINTENANCE = "MAINTENANCE",
}

export interface IntegrationHealth {
  id: string;
  integrationId: string;
  status: string;
  responseTime?: number;
  lastChecked: string;
  errors?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Integration {
  id: string;
  name: string;
  type: IntegrationType;
  status: IntegrationStatus;
  configuration: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  healthCheck?: IntegrationHealth;
  lastSync?: string;
  errors?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationQuery {
  type?:
    | "EMAIL"
    | "SONARQUBE"
    | "OWASP_ZAP"
    | "DEPENDENCY_CHECK"
    | "METASPLOIT"
    | "TESTSSL"
    | "SIEM"
    | "SOAR"
    | "SLACK";
  status?: "ERROR" | "MAINTENANCE" | "ACTIVE" | "INACTIVE";
  page?: number;
  limit?: number;
}

// Settings
export interface SystemSetting {
  key: string;
  value: string | number | boolean | Record<string, unknown>;
  type: "string" | "number" | "boolean" | "json";
  description?: string;
  category: string;
  updatedAt: string;
}

export interface SettingsQuery {
  category?: string;
}

export interface GeneralSettingsDto {
  organizationName: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  language: string;
  defaultDashboard: string;
  maintenanceMode: boolean;
  maintenanceMessage?: string;
  lastUsedExternalSourceId?: string | null;
}

export interface SecurityPolicyDto {
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumbers: boolean;
  passwordRequireSpecialChars: boolean;
  passwordExpirationDays: number;
  sessionTimeoutMinutes: number;
  rememberMeExpiryHours: number;
  maxLoginAttempts: number;
  lockoutDurationMinutes: number;
  twoFactorRequired: boolean;
  twoFactorGracePeriodDays: number;
  twoFactorEnabledDate?: string;
  twoFactorEnforcementMode: "warn" | "block";
  ipWhitelistEnabled: boolean;
  ipWhitelist: string[];
}

export interface NotificationSettingsDto {
  emailEnabled: boolean;
  emailServer: string;
  emailPort: number;
  emailSecure: boolean;
  emailFrom: string;
  slackEnabled: boolean;
  slackWebhookUrl?: string;
  teamsEnabled: boolean;
  teamsWebhookUrl?: string;
  webhookEnabled: boolean;
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
}

export interface AlertRuleDto {
  id: string;
  name: string;
  enabled: boolean;
  type: "vulnerability" | "threat" | "agent" | "scan" | "incident";
  severity: string[];
  channels: string[];
  recipients: string[];
  conditions: Record<string, unknown>;
}

export interface AllSettingsDto {
  general: GeneralSettingsDto;
  security: SecurityPolicyDto;
  notifications: NotificationSettingsDto;
  alertRules: AlertRuleDto[];
}

// LLM Provider Types
export type ProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter";
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

export interface UserSettings {
  userId: number;
  theme: "light" | "dark" | "system";
  language: string;
  timezone: string;
  emailNotifications: boolean;
  slackNotifications: boolean;
  dashboardLayout: Record<string, unknown>;
  preferences: Record<string, unknown>;
}

// Audit Logs
export interface AuditLog {
  id: string;
  action: string;
  resource: string;
  resourceId?: string;
  userId?: number;
  userEmail?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogQuery {
  action?: string;
  resource?: string;
  userId?: number;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

// Ticket types
export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  type: TicketType;
  assigneeId?: number;
  reporterId: number;
  vulnerabilityId?: string;
  incidentId?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  assignee?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  reporter?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  vulnerability?: {
    id: string;
    title: string;
    severity: string;
  };
}

export interface TicketQuery {
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  assigneeId?: number;
  reporterId?: number;
  vulnerabilityId?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface CreateTicket {
  title: string;
  description: string;
  priority: TicketPriority;
  type: TicketType;
  assigneeId?: number;
  reporterId: number;
  vulnerabilityId?: string;
  incidentId?: string;
}

export interface UpdateTicket {
  title?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  type?: TicketType;
  assigneeId?: number;
  resolution?: string;
}

// Incident types
export interface Incident {
  id: string;
  title: string;
  description: string;
  type:
    | "MALWARE"
    | "PHISHING"
    | "SECURITY_BREACH"
    | "DATA_LEAK"
    | "UNAUTHORIZED_ACCESS"
    | "POLICY_VIOLATION"
    | "VULNERABILITY_EXPLOIT"
    | "DDOS"
    | "OTHER";
  status: "OPEN" | "RESOLVED" | "FALSE_POSITIVE" | "INVESTIGATING" | "CLOSED";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "URGENT";
  impactLevel?: "HIGH" | "MEDIUM" | "LOW";
  assignedToId?: number;
  reporterId: number;
  affectedSystems?: string[];
  evidenceData?: Record<string, unknown>;
  mitigation?: string;
  timeline?: Record<string, unknown>[];
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  closedAt?: string;
  // External ticket integration fields (provider-agnostic)
  externalTicketId?: string;
  externalTicketNumber?: string;
  ticketProvider?: string;
  ticketUrl?: string;
  ticketStatus?: string;
  name?: string; // Alias for title
  cvss?: number; // For compatibility
  assignedTo?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  reporter?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  vulnerabilities?: {
    id: string;
    title: string;
    severity: string;
  }[];
}

// DTO types for WebSocket hooks
export interface ActivityDto {
  id: string;
  type: string;
  description: string;
  severity?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  user?: {
    id: number;
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  agent?: {
    id: string;
    name: string;
    hostname?: string;
  };
  vulnerability?: {
    id: string;
    title: string;
    severity: string;
  };
}

export interface AnalyticsOverviewDto {
  totalAgents: number;
  onlineAgents: number;
  offlineAgents: number;
  totalVulnerabilities: number;
  criticalVulnerabilities: number;
  highVulnerabilities: number;
  mediumVulnerabilities: number;
  lowVulnerabilities: number;
  resolvedVulnerabilities: number;
  openVulnerabilities: number;
  totalScans: number;
  completedScans: number;
  failedScans: number;
  runningScans: number;
  threatIntelCount: number;
  activeThreatCount: number;
  agentHealthScore: number;
  securityScore: number;
  criticalVulnerabilitiesTrend?: TrendData;
  openVulnerabilitiesTrend?: TrendData;
  complianceScoreTrend?: TrendData;
  updatedAt?: string;
}

export interface SecurityMetricsDto {
  totalVulnerabilities: number;
  criticalVulnerabilities: number;
  highVulnerabilities: number;
  mediumVulnerabilities: number;
  lowVulnerabilities: number;
  resolvedVulnerabilities: number;
  openVulnerabilities: number;
  securityScore: number;
  complianceScore: number;
  agentHealthScore: number;
  lastUpdated: string;
}

export interface ThreatIntelligenceDto {
  id: string;
  title: string;
  description: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  source: string;
  indicators: string[];
  affectedSystems: string[];
  recommendations: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  attackVectors?: { name: string; count: number }[];
  threatSources?: {
    country: string;
    count: number;
    lat: number;
    lng: number;
  }[];
  severityBreakdown?: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}
