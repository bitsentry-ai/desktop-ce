import BetterSqlite3 from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  integer,
  real,
  sqliteTable,
  text,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'

const roleTable = sqliteTable('Role', {
  id: integer('id').primaryKey(),
  name: text('name'),
})

const statusTable = sqliteTable('Status', {
  id: integer('id').primaryKey(),
  name: text('name'),
})

const userTable = sqliteTable('User', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email'),
  password: text('password'),
  firstName: text('firstName'),
  lastName: text('lastName'),
  provider: text('provider').notNull(),
  roleId: integer('roleId'),
  statusId: integer('statusId'),
  lastLoginAt: text('lastLoginAt'),
  totpSecret: text('totpSecret'),
  totpEnabled: integer('totpEnabled', { mode: 'boolean' }).notNull(),
  totpBackupCodes: text('totpBackupCodes'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  deletedAt: text('deletedAt'),
})

const sessionTable = sqliteTable('Session', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('userId').notNull(),
  hash: text('hash').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  deletedAt: text('deletedAt'),
})

const settingTable = sqliteTable('Setting', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  type: text('type'),
  description: text('description'),
  userId: integer('userId'),
  createdAt: text('createdAt'),
  updatedAt: text('updatedAt'),
})

const auditLogTable = sqliteTable('AuditLog', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  action: text('action').notNull(),
  userId: integer('userId'),
  details: text('details'),
  createdAt: text('createdAt').notNull(),
})

const agentTable = sqliteTable('Agent', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type').notNull(),
  status: text('status').notNull(),
  version: text('version').notNull(),
  hostname: text('hostname'),
  ipAddress: text('ipAddress'),
  operatingSystem: text('operatingSystem'),
  configuration: text('configuration'),
  capabilities: text('capabilities').notNull(),
  lastHeartbeat: text('lastHeartbeat'),
  lastSeen: text('lastSeen'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  deletedAt: text('deletedAt'),
})

const agentHealthTable = sqliteTable('AgentHealth', {
  id: text('id').primaryKey(),
  agentId: text('agentId').notNull(),
  cpuUsage: real('cpuUsage'),
  memoryUsage: real('memoryUsage'),
  diskUsage: real('diskUsage'),
  networkIn: real('networkIn'),
  networkOut: real('networkOut'),
  uptime: real('uptime'),
  errors: text('errors'),
  warnings: text('warnings'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const agentTagTable = sqliteTable('AgentTag', {
  id: text('id').primaryKey(),
  agentId: text('agentId').notNull(),
  key: text('key').notNull(),
  value: text('value').notNull(),
  createdAt: text('createdAt').notNull(),
})

const vulnerabilityTable = sqliteTable('Vulnerability', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  severity: text('severity').notNull(),
  status: text('status').notNull(),
  cvssScore: real('cvssScore'),
  cveId: text('cveId'),
  source: text('source'),
  affectedAsset: text('affectedAsset'),
  remediation: text('remediation'),
  assignedToId: integer('assignedToId'),
  falsePositiveJustification: text('falsePositiveJustification'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  deletedAt: text('deletedAt'),
})

const vulnerabilityAgentTable = sqliteTable('VulnerabilityAgent', {
  id: text('id').primaryKey(),
  vulnerabilityId: text('vulnerabilityId').notNull(),
  agentId: text('agentId').notNull(),
})

const vulnerabilityTimelineTable = sqliteTable('VulnerabilityTimeline', {
  id: text('id').primaryKey(),
  vulnerabilityId: text('vulnerabilityId').notNull(),
  action: text('action').notNull(),
  comment: text('comment'),
  userId: integer('userId'),
  oldStatus: text('oldStatus'),
  newStatus: text('newStatus'),
  createdAt: text('createdAt').notNull(),
})

const threatIntelligenceTable = sqliteTable('ThreatIntelligence', {
  id: text('id').primaryKey(),
  source: text('source').notNull(),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  mitre: text('mitre'),
  confidence: integer('confidence'),
  active: integer('active', { mode: 'boolean' }).notNull(),
  expiresAt: text('expiresAt'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const threatIndicatorTable = sqliteTable('ThreatIndicator', {
  id: text('id').primaryKey(),
  threatId: text('threatId').notNull(),
  type: text('type').notNull(),
  value: text('value').notNull(),
  description: text('description'),
  createdAt: text('createdAt').notNull(),
})

const integrationTable = sqliteTable('Integration', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  configuration: text('configuration').notNull(),
  credentials: text('credentials'),
  lastSync: text('lastSync'),
  errors: text('errors'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const integrationHealthTable = sqliteTable('IntegrationHealth', {
  id: text('id').primaryKey(),
  integrationId: text('integrationId').notNull(),
  status: text('status').notNull(),
  responseTime: real('responseTime'),
  lastChecked: text('lastChecked').notNull(),
  errors: text('errors'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const errorSourceTable = sqliteTable('ErrorSource', {
  id: text('id').primaryKey(),
  sourceType: text('sourceType').notNull(),
  name: text('name').notNull(),
  accessTokenRef: text('accessTokenRef'),
  refreshTokenRef: text('refreshTokenRef'),
  expiresAt: text('expiresAt'),
  grantedScopes: text('grantedScopes').notNull(),
  configuration: text('configuration').notNull(),
  logLevelThreshold: text('logLevelThreshold').notNull(),
  additionalMetadata: text('additionalMetadata'),
  syncEnabled: integer('syncEnabled', { mode: 'boolean' }).notNull(),
  autoDiagnosisEnabled: integer('autoDiagnosisEnabled', { mode: 'boolean' }).notNull(),
  lastSyncAt: text('lastSyncAt'),
  lastSyncStatus: text('lastSyncStatus'),
  lastSyncError: text('lastSyncError'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const errorIssueTable = sqliteTable('ErrorIssue', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  externalIssueId: text('externalIssueId').notNull(),
  externalShortId: text('externalShortId'),
  title: text('title').notNull(),
  culprit: text('culprit'),
  type: text('type'),
  metadata: text('metadata'),
  projectIdentifier: text('projectIdentifier'),
  level: text('level').notNull(),
  status: text('status').notNull(),
  isUnhandled: integer('isUnhandled', { mode: 'boolean' }),
  firstSeen: text('firstSeen').notNull(),
  lastSeen: text('lastSeen').notNull(),
  eventCount: integer('eventCount').notNull(),
  userCount: integer('userCount'),
  tags: text('tags'),
  environment: text('environment'),
  release: text('release'),
  platform: text('platform'),
  additionalMetadata: text('additionalMetadata'),
  diagnosisStatus: text('diagnosisStatus'),
  diagnosisResult: text('diagnosisResult'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const errorEventTable = sqliteTable('ErrorEvent', {
  id: text('id').primaryKey(),
  sourceId: text('sourceId').notNull(),
  issueId: text('issueId').notNull(),
  externalEventId: text('externalEventId').notNull(),
  timestamp: text('timestamp').notNull(),
  message: text('message'),
  exceptionType: text('exceptionType'),
  exceptionValue: text('exceptionValue'),
  exceptionMechanism: text('exceptionMechanism'),
  stacktrace: text('stacktrace'),
  inAppFrames: text('inAppFrames'),
  tags: text('tags'),
  contexts: text('contexts'),
  userContext: text('userContext'),
  requestContext: text('requestContext'),
  environment: text('environment'),
  release: text('release'),
  serverName: text('serverName'),
  traceId: text('traceId'),
  requestId: text('requestId'),
  transactionName: text('transactionName'),
  additionalMetadata: text('additionalMetadata'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const ticketTable = sqliteTable('Ticket', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  priority: text('priority').notNull(),
  externalTicketId: text('externalTicketId'),
  externalTicketNumber: text('externalTicketNumber'),
  ticketProvider: text('ticketProvider').notNull(),
  ticketUrl: text('ticketUrl'),
  vulnerabilityId: text('vulnerabilityId'),
  incidentId: text('incidentId'),
  diagnosisId: integer('diagnosisId'),
  automatic: integer('automatic', { mode: 'boolean' }).notNull(),
  resolutionType: text('resolutionType'),
  resolutionNotes: text('resolutionNotes'),
  lessonsLearned: text('lessonsLearned'),
  resolvedAt: text('resolvedAt'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const jobRunTable = sqliteTable('JobRun', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  payload: text('payload'),
  result: text('result'),
  error: text('error'),
  attempt: integer('attempt').notNull(),
  maxAttempts: integer('maxAttempts').notNull(),
  timeoutMs: integer('timeoutMs').notNull(),
  scheduledAt: text('scheduledAt'),
  startedAt: text('startedAt'),
  completedAt: text('completedAt'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const reportTable = sqliteTable('Report', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  format: text('format').notNull(),
  status: text('status').notNull(),
  parameters: text('parameters'),
  content: text('content'),
  filePath: text('filePath'),
  scheduledAt: text('scheduledAt'),
  completedAt: text('completedAt'),
  userId: integer('userId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const scanTable = sqliteTable('Scan', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  status: text('status').notNull(),
  target: text('target'),
  configuration: text('configuration'),
  results: text('results'),
  summary: text('summary'),
  progress: integer('progress'),
  startedAt: text('startedAt'),
  completedAt: text('completedAt'),
  jobRunId: text('jobRunId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const telemetryDailyTable = sqliteTable('TelemetryDaily', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telemetryDate: text('telemetryDate').notNull(),
  currentState: text('currentState').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const telemetryEntryTable = sqliteTable('TelemetryEntry', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telemetryId: integer('telemetryId').notNull(),
  entryId: text('entryId'),
  entryIndex: text('entryIndex'),
  entryScore: real('entryScore'),
  entrySource: text('entrySource'),
  entryTimestamp: text('entryTimestamp').notNull(),
  fullLog: text('fullLog').notNull(),
  decoderName: text('decoderName'),
  location: text('location'),
  agentName: text('agentName'),
  agentIp: text('agentIp'),
  ruleId: integer('ruleId'),
  ruleDescription: text('ruleDescription'),
  ruleLevel: integer('ruleLevel'),
  processName: text('processName'),
  inputType: text('inputType'),
  hostname: text('hostname'),
  groups: text('groups'),
  ruleGroups: text('ruleGroups'),
  category: text('category').notNull(),
  state: text('state').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisEntryTable = sqliteTable('DiagnosisEntry', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  telemetryEntryId: integer('telemetryEntryId'),
  currentState: text('currentState').notNull(),
  stateHistory: text('stateHistory').notNull(),
  stateTexts: text('stateTexts'),
  sourceCategory: text('sourceCategory').notNull(),
  sourceKind: text('sourceKind').notNull(),
  logLevel: text('logLevel').notNull(),
  severity: text('severity').notNull(),
  category: text('category').notNull(),
  categoryConfidence: real('categoryConfidence'),
  description: text('description'),
  environment: text('environment'),
  sourceMetadata: text('sourceMetadata'),
  normalizedData: text('normalizedData'),
  verificationData: text('verificationData'),
  debugPayload: text('debugPayload'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisEntrySourceRefTable = sqliteTable('DiagnosisEntrySourceRef', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  diagnosisEntryId: integer('diagnosisEntryId').notNull(),
  sourceTableName: text('sourceTableName').notNull(),
  sourceFieldName: text('sourceFieldName').notNull(),
  sourceKeyValue: text('sourceKeyValue').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const cveEntryTable = sqliteTable('CveEntry', {
  id: text('id').primaryKey(),
  summary: text('summary'),
  severity: text('severity'),
  cvssScore: real('cvssScore'),
  publishedAt: text('publishedAt'),
  lastModifiedAt: text('lastModifiedAt'),
  references: text('references'),
  metadata: text('metadata'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const telemetryCveLinkTable = sqliteTable('TelemetryCveLink', {
  id: text('id').primaryKey(),
  telemetryEntryId: integer('telemetryEntryId').notNull(),
  cveId: text('cveId').notNull(),
  createdAt: text('createdAt').notNull(),
})

const jobScheduleTable = sqliteTable('JobSchedule', {
  jobKey: text('jobKey').primaryKey(),
  cronExpression: text('cronExpression').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  lastRunAt: text('lastRunAt'),
  nextRunAt: text('nextRunAt'),
  catchUpWindowHours: integer('catchUpWindowHours').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const incidentThreadTable = sqliteTable('IncidentThread', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  state: text('state').notNull(),
  sessionId: text('sessionId'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  archivedAt: text('archivedAt'),
  deletedAt: text('deletedAt'),
})

const incidentMessageTable = sqliteTable('IncidentMessage', {
  id: text('id').primaryKey(),
  threadId: text('threadId').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  kind: text('kind').notNull(),
  text: text('text'),
  streamText: text('streamText'),
  toolCallsJson: text('toolCallsJson'),
  finalText: text('finalText'),
  status: text('status'),
  errorMsg: text('errorMsg'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const globalVariableTable = sqliteTable('GlobalVariable', {
  id: text('id').primaryKey(),
  key: text('key').notNull(),
  value: text('value'),
  valueRef: text('valueRef'),
  description: text('description'),
  secure: integer('secure', { mode: 'boolean' }).notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const runbookTable = sqliteTable('Runbook', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  idleTimeout: integer('idleTimeout'),
  revisionNumber: integer('revisionNumber').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
  deletedAt: text('deletedAt'),
})

const runbookActionTable = sqliteTable('RunbookAction', {
  id: text('id').primaryKey(),
  runbookId: text('runbookId').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  command: text('command'),
  prompt: text('prompt'),
  llmProviderKey: text('llmProviderKey'),
  llmModel: text('llmModel'),
  url: text('url'),
  method: text('method'),
  headersJson: text('headersJson'),
  body: text('body'),
  query: text('query'),
  sourceId: text('sourceId'),
  parametersJson: text('parametersJson'),
  logFilterJson: text('logFilterJson'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const runbookVersionTable = sqliteTable('RunbookVersion', {
  id: text('id').primaryKey(),
  runbookId: text('runbookId').notNull(),
  versionNumber: integer('versionNumber').notNull(),
  isLatest: integer('isLatest', { mode: 'boolean' }).notNull(),
  actionsJson: text('actionsJson').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisSessionTable = sqliteTable('DiagnosisSession', {
  id: text('id').primaryKey(),
  runbookId: text('runbookId').notNull(),
  runbookVersionId: text('runbookVersionId'),
  runbookTitle: text('runbookTitle').notNull(),
  runbookRevisionNumber: integer('runbookRevisionNumber'),
  runbookContextJson: text('runbookContextJson'),
  executionId: text('executionId'),
  executionSnapshotJson: text('executionSnapshotJson'),
  status: text('status').notNull(),
  startedAt: text('startedAt').notNull(),
  completedAt: text('completedAt'),
  prompt: text('prompt').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisTraceEntryTable = sqliteTable('DiagnosisTraceEntry', {
  id: text('id').primaryKey(),
  diagnosisSessionId: text('diagnosisSessionId').notNull(),
  content: text('content').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisToolRunTable = sqliteTable('DiagnosisToolRun', {
  id: text('id').primaryKey(),
  diagnosisSessionId: text('diagnosisSessionId').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  toolCallId: text('toolCallId').notNull(),
  toolName: text('toolName').notNull(),
  state: text('state').notNull(),
  output: text('output'),
  error: text('error'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const diagnosisReportTable = sqliteTable('DiagnosisReport', {
  id: text('id').primaryKey(),
  diagnosisSessionId: text('diagnosisSessionId').notNull(),
  content: text('content').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const investigationSessionTable = sqliteTable('InvestigationSession', {
  id: text('id').primaryKey(),
  runbookId: text('runbookId').notNull(),
  runbookVersionId: text('runbookVersionId'),
  runbookTitle: text('runbookTitle').notNull(),
  runbookRevisionNumber: integer('runbookRevisionNumber'),
  runbookContextJson: text('runbookContextJson'),
  executionId: text('executionId'),
  incidentThreadId: text('incidentThreadId'),
  executionSnapshotJson: text('executionSnapshotJson'),
  status: text('status').notNull(),
  startedAt: text('startedAt').notNull(),
  completedAt: text('completedAt'),
  prompt: text('prompt').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const investigationTraceEntryTable = sqliteTable('InvestigationTraceEntry', {
  id: text('id').primaryKey(),
  investigationSessionId: text('investigationSessionId').notNull(),
  content: text('content').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const investigationToolRunTable = sqliteTable('InvestigationToolRun', {
  id: text('id').primaryKey(),
  investigationSessionId: text('investigationSessionId').notNull(),
  sortOrder: integer('sortOrder').notNull(),
  toolCallId: text('toolCallId').notNull(),
  toolName: text('toolName').notNull(),
  state: text('state').notNull(),
  output: text('output'),
  error: text('error'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const investigationReportTable = sqliteTable('InvestigationReport', {
  id: text('id').primaryKey(),
  investigationSessionId: text('investigationSessionId').notNull(),
  content: text('content').notNull(),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const activityEventTable = sqliteTable('ActivityEvent', {
  id: text('id').primaryKey(),
  entityType: text('entityType').notNull(),
  entityId: text('entityId').notNull(),
  eventType: text('eventType').notNull(),
  payloadJson: text('payloadJson'),
  createdAt: text('createdAt').notNull(),
  updatedAt: text('updatedAt').notNull(),
})

const legacyImportLedgerTable = sqliteTable('LegacyImportLedger', {
  key: text('key').primaryKey(),
  importedAt: text('importedAt').notNull(),
  payloadJson: text('payloadJson'),
})

const modelTables = {
  role: roleTable,
  status: statusTable,
  user: userTable,
  session: sessionTable,
  setting: settingTable,
  auditLog: auditLogTable,
  agent: agentTable,
  agentHealth: agentHealthTable,
  agentTag: agentTagTable,
  vulnerability: vulnerabilityTable,
  vulnerabilityAgent: vulnerabilityAgentTable,
  vulnerabilityTimeline: vulnerabilityTimelineTable,
  threatIntelligence: threatIntelligenceTable,
  threatIndicator: threatIndicatorTable,
  integration: integrationTable,
  integrationHealth: integrationHealthTable,
  errorSource: errorSourceTable,
  errorIssue: errorIssueTable,
  errorEvent: errorEventTable,
  ticket: ticketTable,
  jobRun: jobRunTable,
  report: reportTable,
  scan: scanTable,
  telemetryDaily: telemetryDailyTable,
  telemetryEntry: telemetryEntryTable,
  diagnosisEntry: diagnosisEntryTable,
  diagnosisEntrySourceRef: diagnosisEntrySourceRefTable,
  cveEntry: cveEntryTable,
  telemetryCveLink: telemetryCveLinkTable,
  jobSchedule: jobScheduleTable,
  incidentThread: incidentThreadTable,
  incidentMessage: incidentMessageTable,
  globalVariable: globalVariableTable,
  runbook: runbookTable,
  runbookAction: runbookActionTable,
  runbookVersion: runbookVersionTable,
  diagnosisSession: diagnosisSessionTable,
  diagnosisTraceEntry: diagnosisTraceEntryTable,
  diagnosisToolRun: diagnosisToolRunTable,
  diagnosisReport: diagnosisReportTable,
  investigationSession: investigationSessionTable,
  investigationTraceEntry: investigationTraceEntryTable,
  investigationToolRun: investigationToolRunTable,
  investigationReport: investigationReportTable,
  activityEvent: activityEventTable,
  legacyImportLedger: legacyImportLedgerTable,
} as const

type ModelName = keyof typeof modelTables
type WhereInput = Record<string, unknown>
type SelectInput = Record<string, boolean>
type IncludeInput = Record<string, unknown>
type OrderByInput = Record<string, 'asc' | 'desc'>

interface FindManyArgs {
  where?: WhereInput
  include?: IncludeInput
  select?: SelectInput
  orderBy?: OrderByInput
  skip?: number
  take?: number
}

interface FindUniqueArgs extends FindManyArgs {
  where: WhereInput
}

interface CreateArgs {
  data: Record<string, unknown>
  include?: IncludeInput
  select?: SelectInput
}

interface UpdateArgs {
  where: WhereInput
  data: Record<string, unknown>
  include?: IncludeInput
  select?: SelectInput
}

interface UpdateManyArgs {
  where?: WhereInput
  data: Record<string, unknown>
}

interface DeleteArgs {
  where: WhereInput
}

interface DeleteManyArgs {
  where?: WhereInput
}

interface CountArgs {
  where?: WhereInput
}

interface GroupByArgs {
  by: string[]
  where?: WhereInput
  _count?: true | { _all?: boolean }
}

interface UpsertArgs {
  where: WhereInput
  create: Record<string, unknown>
  update: Record<string, unknown>
}

interface ModelDelegate {
  findUnique(args: FindUniqueArgs): Promise<Record<string, unknown> | null>
  findFirst(args?: FindManyArgs): Promise<Record<string, unknown> | null>
  findMany(args?: FindManyArgs): Promise<Record<string, unknown>[]>
  count(args?: CountArgs): Promise<number>
  create(args: CreateArgs): Promise<Record<string, unknown>>
  update(args: UpdateArgs): Promise<Record<string, unknown>>
  updateMany(args: UpdateManyArgs): Promise<{ count: number }>
  delete(args: DeleteArgs): Promise<Record<string, unknown>>
  deleteMany(args?: DeleteManyArgs): Promise<{ count: number }>
  groupBy(args: GroupByArgs): Promise<Record<string, unknown>[]>
  upsert(args: UpsertArgs): Promise<Record<string, unknown>>
}

function combineSqlConditions(conditions: SQL[]): SQL | undefined {
  if (conditions.length === 0) {
    return undefined
  }

  if (conditions.length === 1) {
    return conditions[0]
  }

  return and(...conditions)
}

function combineSqlOrConditions(conditions: SQL[]): SQL | undefined {
  if (conditions.length === 0) {
    return undefined
  }

  if (conditions.length === 1) {
    return conditions[0]
  }

  return or(...conditions)
}

function toSqlLikeText(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value)
  }

  return JSON.stringify(value)
}

function includeEnabled(include: IncludeInput, key: string): boolean {
  const value = include[key]
  return value !== undefined && value !== null && value !== false
}

function getModelColumn(model: ModelName, field: string): AnySQLiteColumn | undefined {
  const columns: Record<string, AnySQLiteColumn | undefined> = modelColumns[model]
  return columns[field]
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function setDefaultValue(
  output: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (output[key] === undefined) {
    output[key] = value
  }
}

function setUuidDefault(output: Record<string, unknown>): void {
  setDefaultValue(output, 'id', randomUUID())
}

function applyErrorSourceCreateDefaults(output: Record<string, unknown>): void {
  setUuidDefault(output)
  setDefaultValue(output, 'syncEnabled', true)
  setDefaultValue(output, 'autoDiagnosisEnabled', false)
  setDefaultValue(output, 'grantedScopes', '[]')
  setDefaultValue(output, 'configuration', '{}')
}

function applyDiagnosisEntryCreateDefaults(output: Record<string, unknown>): void {
  setDefaultValue(output, 'sourceCategory', 'telemetry')
  setDefaultValue(output, 'sourceKind', 'telemetry_entry')
  setDefaultValue(output, 'logLevel', 'infrastructure')
  setDefaultValue(output, 'severity', 'unknown')
  setDefaultValue(output, 'category', 'unknown')
  setDefaultValue(output, 'stateTexts', '{}')
  setDefaultValue(output, 'stateHistory', '[]')
  setDefaultValue(output, 'currentState', 'pending')
}

function applyModelCreateDefaults(model: ModelName, output: Record<string, unknown>): void {
  if (model === 'setting') {
    setDefaultValue(output, 'type', 'string')
    return
  }
  if (model === 'user') {
    setDefaultValue(output, 'totpEnabled', false)
    return
  }
  if (model === 'errorSource') {
    applyErrorSourceCreateDefaults(output)
    return
  }
  if (model === 'errorIssue') {
    setUuidDefault(output)
    setDefaultValue(output, 'eventCount', 1)
    return
  }
  if (model === 'errorEvent') {
    setUuidDefault(output)
    return
  }
  if (model === 'diagnosisEntry') {
    applyDiagnosisEntryCreateDefaults(output)
  }
}

function applyTimestampCreateDefaults(model: ModelName, output: Record<string, unknown>): void {
  const now = new Date().toISOString()
  if (dateColumnsByModel[model].has('createdAt')) {
    setDefaultValue(output, 'createdAt', now)
  }
  if (dateColumnsByModel[model].has('updatedAt')) {
    setDefaultValue(output, 'updatedAt', now)
  }
}

function hydrateDateField(value: unknown): unknown {
  if (value instanceof Date) return value
  const asDate = new Date(toSqlLikeText(value))
  if (!Number.isNaN(asDate.getTime())) return asDate
  return value
}

function hydrateBooleanField(value: unknown): unknown {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value !== '0' && value.toLowerCase() !== 'false'
  return value
}

export interface DbClientOptions {
  datasources?: {
    db?: {
      url?: string
    }
  }
  log?: unknown
}

const modelColumns: Record<ModelName, Record<string, AnySQLiteColumn>> = {
  role: getTableColumns(roleTable),
  status: getTableColumns(statusTable),
  user: getTableColumns(userTable),
  session: getTableColumns(sessionTable),
  setting: getTableColumns(settingTable),
  auditLog: getTableColumns(auditLogTable),
  agent: getTableColumns(agentTable),
  agentHealth: getTableColumns(agentHealthTable),
  agentTag: getTableColumns(agentTagTable),
  vulnerability: getTableColumns(vulnerabilityTable),
  vulnerabilityAgent: getTableColumns(vulnerabilityAgentTable),
  vulnerabilityTimeline: getTableColumns(vulnerabilityTimelineTable),
  threatIntelligence: getTableColumns(threatIntelligenceTable),
  threatIndicator: getTableColumns(threatIndicatorTable),
  integration: getTableColumns(integrationTable),
  integrationHealth: getTableColumns(integrationHealthTable),
  errorSource: getTableColumns(errorSourceTable),
  errorIssue: getTableColumns(errorIssueTable),
  errorEvent: getTableColumns(errorEventTable),
  ticket: getTableColumns(ticketTable),
  jobRun: getTableColumns(jobRunTable),
  report: getTableColumns(reportTable),
  scan: getTableColumns(scanTable),
  telemetryDaily: getTableColumns(telemetryDailyTable),
  telemetryEntry: getTableColumns(telemetryEntryTable),
  diagnosisEntry: getTableColumns(diagnosisEntryTable),
  diagnosisEntrySourceRef: getTableColumns(diagnosisEntrySourceRefTable),
  cveEntry: getTableColumns(cveEntryTable),
  telemetryCveLink: getTableColumns(telemetryCveLinkTable),
  jobSchedule: getTableColumns(jobScheduleTable),
  incidentThread: getTableColumns(incidentThreadTable),
  incidentMessage: getTableColumns(incidentMessageTable),
  globalVariable: getTableColumns(globalVariableTable),
  runbook: getTableColumns(runbookTable),
  runbookAction: getTableColumns(runbookActionTable),
  runbookVersion: getTableColumns(runbookVersionTable),
  diagnosisSession: getTableColumns(diagnosisSessionTable),
  diagnosisTraceEntry: getTableColumns(diagnosisTraceEntryTable),
  diagnosisToolRun: getTableColumns(diagnosisToolRunTable),
  diagnosisReport: getTableColumns(diagnosisReportTable),
  investigationSession: getTableColumns(investigationSessionTable),
  investigationTraceEntry: getTableColumns(investigationTraceEntryTable),
  investigationToolRun: getTableColumns(investigationToolRunTable),
  investigationReport: getTableColumns(investigationReportTable),
  activityEvent: getTableColumns(activityEventTable),
  legacyImportLedger: getTableColumns(legacyImportLedgerTable),
}

const dateColumnsByModel: Record<ModelName, Set<string>> = {
  role: new Set(),
  status: new Set(),
  user: new Set(['lastLoginAt', 'createdAt', 'updatedAt', 'deletedAt']),
  session: new Set(['createdAt', 'updatedAt', 'deletedAt']),
  setting: new Set(['createdAt', 'updatedAt']),
  auditLog: new Set(['createdAt']),
  agent: new Set(['lastHeartbeat', 'lastSeen', 'createdAt', 'updatedAt', 'deletedAt']),
  agentHealth: new Set(['createdAt', 'updatedAt']),
  agentTag: new Set(['createdAt']),
  vulnerability: new Set(['createdAt', 'updatedAt', 'deletedAt']),
  vulnerabilityAgent: new Set(),
  vulnerabilityTimeline: new Set(['createdAt']),
  threatIntelligence: new Set(['expiresAt', 'createdAt', 'updatedAt']),
  threatIndicator: new Set(['createdAt']),
  integration: new Set(['lastSync', 'createdAt', 'updatedAt']),
  integrationHealth: new Set(['lastChecked', 'createdAt', 'updatedAt']),
  errorSource: new Set(['expiresAt', 'lastSyncAt', 'createdAt', 'updatedAt']),
  errorIssue: new Set(['firstSeen', 'lastSeen', 'createdAt', 'updatedAt']),
  errorEvent: new Set(['timestamp', 'createdAt', 'updatedAt']),
  ticket: new Set(['resolvedAt', 'createdAt', 'updatedAt']),
  jobRun: new Set(['scheduledAt', 'startedAt', 'completedAt', 'createdAt', 'updatedAt']),
  report: new Set(['scheduledAt', 'completedAt', 'createdAt', 'updatedAt']),
  scan: new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt']),
  telemetryDaily: new Set(['createdAt', 'updatedAt']),
  telemetryEntry: new Set(['entryTimestamp', 'createdAt', 'updatedAt']),
  diagnosisEntry: new Set(['createdAt', 'updatedAt']),
  diagnosisEntrySourceRef: new Set(['createdAt', 'updatedAt']),
  cveEntry: new Set(['publishedAt', 'lastModifiedAt', 'createdAt', 'updatedAt']),
  telemetryCveLink: new Set(['createdAt']),
  jobSchedule: new Set(['lastRunAt', 'nextRunAt', 'createdAt', 'updatedAt']),
  incidentThread: new Set(['createdAt', 'updatedAt', 'archivedAt', 'deletedAt']),
  incidentMessage: new Set(['createdAt', 'updatedAt']),
  globalVariable: new Set(['createdAt', 'updatedAt']),
  runbook: new Set(['createdAt', 'updatedAt', 'deletedAt']),
  runbookAction: new Set(['createdAt', 'updatedAt']),
  runbookVersion: new Set(['createdAt', 'updatedAt']),
  diagnosisSession: new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt']),
  diagnosisTraceEntry: new Set(['createdAt', 'updatedAt']),
  diagnosisToolRun: new Set(['createdAt', 'updatedAt']),
  diagnosisReport: new Set(['createdAt', 'updatedAt']),
  investigationSession: new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt']),
  investigationTraceEntry: new Set(['createdAt', 'updatedAt']),
  investigationToolRun: new Set(['createdAt', 'updatedAt']),
  investigationReport: new Set(['createdAt', 'updatedAt']),
  activityEvent: new Set(['createdAt', 'updatedAt']),
  legacyImportLedger: new Set(['importedAt']),
}

const booleanColumnsByModel: Record<ModelName, Set<string>> = {
  role: new Set(),
  status: new Set(),
  user: new Set(['totpEnabled']),
  session: new Set(),
  setting: new Set(),
  auditLog: new Set(),
  agent: new Set(),
  agentHealth: new Set(),
  agentTag: new Set(),
  vulnerability: new Set(),
  vulnerabilityAgent: new Set(),
  vulnerabilityTimeline: new Set(),
  threatIntelligence: new Set(['active']),
  threatIndicator: new Set(),
  integration: new Set(),
  integrationHealth: new Set(),
  errorSource: new Set(['syncEnabled', 'autoDiagnosisEnabled']),
  errorIssue: new Set(['isUnhandled']),
  errorEvent: new Set(),
  ticket: new Set(['automatic']),
  jobRun: new Set(),
  report: new Set(),
  scan: new Set(),
  telemetryDaily: new Set(),
  telemetryEntry: new Set(),
  diagnosisEntry: new Set(),
  diagnosisEntrySourceRef: new Set(),
  cveEntry: new Set(),
  telemetryCveLink: new Set(),
  jobSchedule: new Set(['enabled']),
  incidentThread: new Set(),
  incidentMessage: new Set(),
  globalVariable: new Set(['secure']),
  runbook: new Set(),
  runbookAction: new Set(),
  runbookVersion: new Set(['isLatest']),
  diagnosisSession: new Set(),
  diagnosisTraceEntry: new Set(),
  diagnosisToolRun: new Set(),
  diagnosisReport: new Set(),
  investigationSession: new Set(),
  investigationTraceEntry: new Set(),
  investigationToolRun: new Set(),
  investigationReport: new Set(),
  activityEvent: new Set(),
  legacyImportLedger: new Set(),
}

function resolveDatabasePath(url: string): string {
  if (!url.startsWith('file:')) return url
  return decodeURIComponent(url.slice('file:'.length))
}

function normalizeSqliteValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
}

export class DbClient {
  private readonly sqlite: BetterSqlite3.Database
  private readonly db: BetterSQLite3Database<typeof modelTables>

  readonly role = this.createDelegate('role')
  readonly status = this.createDelegate('status')
  readonly user = this.createDelegate('user')
  readonly session = this.createDelegate('session')
  readonly setting = this.createDelegate('setting')
  readonly auditLog = this.createDelegate('auditLog')
  readonly agent = this.createDelegate('agent')
  readonly agentHealth = this.createDelegate('agentHealth')
  readonly agentTag = this.createDelegate('agentTag')
  readonly vulnerability = this.createDelegate('vulnerability')
  readonly vulnerabilityAgent = this.createDelegate('vulnerabilityAgent')
  readonly vulnerabilityTimeline = this.createDelegate('vulnerabilityTimeline')
  readonly threatIntelligence = this.createDelegate('threatIntelligence')
  readonly threatIndicator = this.createDelegate('threatIndicator')
  readonly integration = this.createDelegate('integration')
  readonly integrationHealth = this.createDelegate('integrationHealth')
  readonly errorSource = this.createDelegate('errorSource')
  readonly errorIssue = this.createDelegate('errorIssue')
  readonly errorEvent = this.createDelegate('errorEvent')
  readonly ticket = this.createDelegate('ticket')
  readonly jobRun = this.createDelegate('jobRun')
  readonly report = this.createDelegate('report')
  readonly scan = this.createDelegate('scan')
  readonly telemetryDaily = this.createDelegate('telemetryDaily')
  readonly telemetryEntry = this.createDelegate('telemetryEntry')
  readonly diagnosisEntry = this.createDelegate('diagnosisEntry')
  readonly diagnosisEntrySourceRef = this.createDelegate('diagnosisEntrySourceRef')
  readonly cveEntry = this.createDelegate('cveEntry')
  readonly telemetryCveLink = this.createDelegate('telemetryCveLink')
  readonly jobSchedule = this.createDelegate('jobSchedule')
  readonly incidentThread = this.createDelegate('incidentThread')
  readonly incidentMessage = this.createDelegate('incidentMessage')
  readonly globalVariable = this.createDelegate('globalVariable')
  readonly runbook = this.createDelegate('runbook')
  readonly runbookAction = this.createDelegate('runbookAction')
  readonly runbookVersion = this.createDelegate('runbookVersion')
  readonly diagnosisSession = this.createDelegate('diagnosisSession')
  readonly diagnosisTraceEntry = this.createDelegate('diagnosisTraceEntry')
  readonly diagnosisToolRun = this.createDelegate('diagnosisToolRun')
  readonly diagnosisReport = this.createDelegate('diagnosisReport')
  readonly investigationSession = this.createDelegate('investigationSession')
  readonly investigationTraceEntry = this.createDelegate('investigationTraceEntry')
  readonly investigationToolRun = this.createDelegate('investigationToolRun')
  readonly investigationReport = this.createDelegate('investigationReport')
  readonly activityEvent = this.createDelegate('activityEvent')
  readonly legacyImportLedger = this.createDelegate('legacyImportLedger')

  constructor(options?: DbClientOptions) {
    const dbUrl = options?.datasources?.db?.url ?? 'file:bitsentry.db'
    const dbPath = resolveDatabasePath(dbUrl)
    this.sqlite = new BetterSqlite3(dbPath)
    this.sqlite.pragma('foreign_keys = ON')
    this.db = drizzle(this.sqlite, { schema: modelTables })
  }

  $connect(): Promise<void> {
    // better-sqlite3 opens on construction
    return Promise.resolve()
  }

  $disconnect(): Promise<void> {
    this.sqlite.close()
    return Promise.resolve()
  }

  $executeRawUnsafe(statement: string): Promise<unknown> {
    this.sqlite.exec(statement)
    return Promise.resolve(null)
  }

  $queryRawUnsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
  ): Promise<T[]> {
    const prepared = this.sqlite.prepare(statement)
    const rows = prepared.all() as T[]
    return Promise.resolve(rows)
  }

  async $transaction<T>(operation: () => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN IMMEDIATE')
    try {
      const result = await operation()
      this.sqlite.exec('COMMIT')
      return result
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      throw error
    }
  }

  private createDelegate(model: ModelName): ModelDelegate {
    return {
      findUnique: (args: FindUniqueArgs) => this.findUnique(model, args),
      findFirst: (args?: FindManyArgs) => this.findFirst(model, args ?? {}),
      findMany: (args?: FindManyArgs) => this.findMany(model, args ?? {}),
      count: (args?: CountArgs) => this.count(model, args ?? {}),
      create: (args: CreateArgs) => this.create(model, args),
      update: (args: UpdateArgs) => this.update(model, args),
      updateMany: (args: UpdateManyArgs) => this.updateMany(model, args),
      delete: (args: DeleteArgs) => this.delete(model, args),
      deleteMany: (args?: DeleteManyArgs) => this.deleteMany(model, args ?? {}),
      groupBy: (args: GroupByArgs) => this.groupBy(model, args),
      upsert: (args: UpsertArgs) => this.upsert(model, args),
    }
  }

  private async findUnique(model: ModelName, args: FindUniqueArgs): Promise<Record<string, unknown> | null> {
    const rows = await this.findMany(model, { ...args, take: 1 })
    return rows[0] ?? null
  }

  private async findFirst(model: ModelName, args: FindManyArgs): Promise<Record<string, unknown> | null> {
    const rows = await this.findMany(model, { ...args, take: 1 })
    return rows[0] ?? null
  }

  private async findMany(model: ModelName, args: FindManyArgs): Promise<Record<string, unknown>[]> {
    const table = modelTables[model]
    const whereExpr = this.buildWhere(model, args.where)
    const orderExpr = this.buildOrder(model, args.orderBy)

    let query = this.db.select().from(table).$dynamic()

    if (whereExpr !== undefined) query = query.where(whereExpr)
    if (orderExpr !== undefined) query = query.orderBy(orderExpr)
    if (typeof args.take === 'number') query = query.limit(args.take)
    if (typeof args.skip === 'number') query = query.offset(args.skip)

    const baseRows = query.all().map((row) => this.hydrateRow(model, row))

    let rowsWithInclude = baseRows
    if (args.include !== undefined) {
      const include = args.include
      rowsWithInclude = await Promise.all(
        baseRows.map((row) => this.applyInclude(model, row, include)),
      )
    }

    if (args.select === undefined) return rowsWithInclude
    const select = args.select
    return rowsWithInclude.map((row) => this.applySelect(row, select))
  }

  private count(model: ModelName, args: CountArgs): Promise<number> {
    const whereExpr = this.buildWhere(model, args.where)

    let query = this.db
      .select({ value: sql<number>`count(*)` })
      .from(modelTables[model])
      .$dynamic()

    if (whereExpr !== undefined) query = query.where(whereExpr)

    const row = query.get()
    return Promise.resolve(row?.value ?? 0)
  }

  private async create(model: ModelName, args: CreateArgs): Promise<Record<string, unknown>> {
    const prepared = this.applyCreateDefaults(model, this.prepareData(model, args.data))
    const result = this.db.insert(modelTables[model]).values(prepared).run()

    let where: WhereInput | null = null
    if (prepared.id !== undefined) {
      where = { id: prepared.id }
    } else if (typeof result.lastInsertRowid !== 'undefined') {
      where = { id: Number(result.lastInsertRowid) }
    } else if (prepared.key !== undefined) {
      where = { key: prepared.key }
    }

    if (where === null) {
      if (args.select !== undefined) {
        return this.applySelect(prepared, args.select)
      }

      return prepared
    }

    const created = await this.findUnique(model, {
      where,
      include: args.include,
      select: args.select,
    })

    if (created === null) {
      throw new Error(`${model}.create failed to fetch inserted row`)
    }
    return created
  }

  private async update(model: ModelName, args: UpdateArgs): Promise<Record<string, unknown>> {
    const existing = await this.findFirst(model, { where: args.where })
    if (existing === null) {
      throw new Error(`${model}.update target not found`)
    }

    const prepared = this.applyUpdateDefaults(model, this.prepareData(model, args.data))
    if (Object.keys(prepared).length > 0) {
      const whereExpr = this.buildWhere(model, args.where)
      if (whereExpr === undefined) {
        throw new Error(`${model}.update requires where`)
      }
      this.db.update(modelTables[model]).set(prepared).where(whereExpr).run()
    }

    const pkValue = existing.id
    let followupWhere = args.where
    if (pkValue !== undefined) {
      followupWhere = { id: pkValue }
    }
    const updated = await this.findUnique(model, {
      where: followupWhere,
      include: args.include,
      select: args.select,
    })
    if (updated === null) {
      throw new Error(`${model}.update failed to fetch updated row`)
    }
    return updated
  }

  private updateMany(model: ModelName, args: UpdateManyArgs): Promise<{ count: number }> {
    const preparedBase = this.prepareData(model, args.data)
    if (Object.keys(preparedBase).length === 0) return Promise.resolve({ count: 0 })
    const prepared = this.applyUpdateDefaults(model, preparedBase)

    let query = this.db.update(modelTables[model]).set(prepared).$dynamic()
    const whereExpr = this.buildWhere(model, args.where)
    if (whereExpr !== undefined) query = query.where(whereExpr)

    const result = query.run()
    return Promise.resolve({ count: result.changes })
  }

  private async delete(model: ModelName, args: DeleteArgs): Promise<Record<string, unknown>> {
    const existing = await this.findFirst(model, { where: args.where })
    if (existing === null) {
      throw new Error(`${model}.delete target not found`)
    }
    const whereExpr = this.buildWhere(model, args.where)
    if (whereExpr === undefined) {
      throw new Error(`${model}.delete requires where`)
    }
    this.db.delete(modelTables[model]).where(whereExpr).run()
    return existing
  }

  private deleteMany(model: ModelName, args: DeleteManyArgs): Promise<{ count: number }> {
    let query = this.db.delete(modelTables[model]).$dynamic()
    const whereExpr = this.buildWhere(model, args.where)
    if (whereExpr !== undefined) query = query.where(whereExpr)
    const result = query.run()
    return Promise.resolve({ count: result.changes })
  }

  private async upsert(model: ModelName, args: UpsertArgs): Promise<Record<string, unknown>> {
    const existing = await this.findUnique(model, { where: args.where })
    if (existing !== null) {
      return this.update(model, { where: args.where, data: args.update })
    }
    return this.create(model, { data: args.create })
  }

  private groupBy(model: ModelName, args: GroupByArgs): Promise<Record<string, unknown>[]> {
    const groupField = args.by[0]
    if (groupField.length === 0) return Promise.resolve([])

    const column = getModelColumn(model, groupField)
    if (column === undefined) return Promise.resolve([])

    let query = this.db
      .select({
        groupValue: column,
        count: sql<number>`count(*)`,
      })
      .from(modelTables[model])
      .$dynamic()

    const whereExpr = this.buildWhere(model, args.where)
    if (whereExpr !== undefined) query = query.where(whereExpr)

    query = query.groupBy(column)

    const rows = query.all()
    const countAsObject = isPlainObject(args._count)

    return Promise.resolve(rows.map((row) => {
      const value = this.hydrateField(model, groupField, row.groupValue)
      const countValue = row.count
      if (countAsObject) {
        return { [groupField]: value, _count: { _all: countValue } }
      }
      return { [groupField]: value, _count: countValue }
    }))
  }

  private buildWhere(model: ModelName, where?: WhereInput): SQL | undefined {
    if (where === undefined || Object.keys(where).length === 0) return undefined

    const conditions: SQL[] = []

    for (const [field, rawValue] of Object.entries(where)) {
      if (field === 'OR') {
        this.addLogicalCondition(model, conditions, rawValue, 'OR')
        continue
      }

      if (field === 'AND') {
        this.addLogicalCondition(model, conditions, rawValue, 'AND')
        continue
      }

      const column = getModelColumn(model, field)
      if (column === undefined) continue

      const condition = this.buildColumnCondition(model, field, column, rawValue)
      if (condition !== undefined) conditions.push(condition)
    }

    return combineSqlConditions(conditions)
  }

  private addLogicalCondition(
    model: ModelName,
    conditions: SQL[],
    rawValue: unknown,
    operator: 'AND' | 'OR',
  ): void {
    if (!Array.isArray(rawValue)) {
      return
    }

    const nestedConditions: SQL[] = []
    for (const entry of rawValue) {
      if (!isPlainObject(entry)) {
        continue
      }

      const condition = this.buildWhere(model, entry)
      if (condition !== undefined) {
        nestedConditions.push(condition)
      }
    }

    let combined: SQL | undefined
    if (operator === 'OR') {
      combined = combineSqlOrConditions(nestedConditions)
    } else {
      combined = combineSqlConditions(nestedConditions)
    }

    if (combined !== undefined) {
      conditions.push(combined)
    }
  }

  private buildColumnCondition(
    model: ModelName,
    field: string,
    column: AnySQLiteColumn,
    rawValue: unknown,
  ): SQL | undefined {
    if (rawValue === null) {
      return isNull(column)
    }

    if (!isPlainObject(rawValue)) {
      return eq(column, normalizeSqliteValue(rawValue))
    }

    const operations: SQL[] = []
    this.addEqualsOperation(operations, column, rawValue)
    this.addTextMatchOperation(operations, column, rawValue, 'contains')
    this.addTextMatchOperation(operations, column, rawValue, 'startsWith')
    this.addInOperation(operations, column, rawValue)
    this.addComparisonOperation(operations, column, rawValue, 'gte')
    this.addComparisonOperation(operations, column, rawValue, 'lte')
    this.addComparisonOperation(operations, column, rawValue, 'gt')
    this.addComparisonOperation(operations, column, rawValue, 'lt')
    this.addNotOperation(model, field, operations, column, rawValue)

    if (operations.length === 0) {
      return eq(column, normalizeSqliteValue(rawValue))
    }
    return combineSqlConditions(operations)
  }

  private addEqualsOperation(
    operations: SQL[],
    column: AnySQLiteColumn,
    rawValue: Record<string, unknown>,
  ): void {
    if (!hasOwnKey(rawValue, 'equals')) return
    const equalsValue = rawValue.equals
    if (equalsValue === null) {
      operations.push(isNull(column))
      return
    }

    operations.push(eq(column, normalizeSqliteValue(equalsValue)))
  }

  private addTextMatchOperation(
    operations: SQL[],
    column: AnySQLiteColumn,
    rawValue: Record<string, unknown>,
    operation: 'contains' | 'startsWith',
  ): void {
    if (!hasOwnKey(rawValue, operation)) return
    const value = rawValue[operation]
    if (operation === 'contains') {
      operations.push(like(column, `%${toSqlLikeText(value)}%`))
      return
    }

    operations.push(like(column, `${toSqlLikeText(value)}%`))
  }

  private addInOperation(
    operations: SQL[],
    column: AnySQLiteColumn,
    rawValue: Record<string, unknown>,
  ): void {
    if (!hasOwnKey(rawValue, 'in')) return
    const inValue = rawValue.in
    if (!Array.isArray(inValue)) return

    const normalized = inValue.map((item) => normalizeSqliteValue(item))
    if (normalized.length === 0) {
      operations.push(sql`1 = 0`)
      return
    }

    operations.push(inArray(column, normalized))
  }

  private addComparisonOperation(
    operations: SQL[],
    column: AnySQLiteColumn,
    rawValue: Record<string, unknown>,
    operation: 'gte' | 'lte' | 'gt' | 'lt',
  ): void {
    if (!hasOwnKey(rawValue, operation)) return
    const value = normalizeSqliteValue(rawValue[operation])
    if (operation === 'gte') {
      operations.push(gte(column, value))
      return
    }
    if (operation === 'lte') {
      operations.push(lte(column, value))
      return
    }
    if (operation === 'gt') {
      operations.push(gt(column, value))
      return
    }

    operations.push(lt(column, value))
  }

  private addNotOperation(
    model: ModelName,
    field: string,
    operations: SQL[],
    column: AnySQLiteColumn,
    rawValue: Record<string, unknown>,
  ): void {
    if (!hasOwnKey(rawValue, 'not')) return
    const notValue = rawValue.not
    if (notValue === null) {
      operations.push(isNotNull(column))
      return
    }
    if (isPlainObject(notValue)) {
      const nested = this.buildColumnCondition(model, field, column, notValue)
      if (nested !== undefined) operations.push(not(nested))
      return
    }

    operations.push(ne(column, normalizeSqliteValue(notValue)))
  }

  private buildOrder(model: ModelName, orderBy?: OrderByInput): SQL | undefined {
    if (orderBy === undefined) return undefined
    const orderEntries = Object.entries(orderBy)
    const orderEntry = orderEntries[0]
    if (orderEntry === undefined) return undefined
    const [field, direction] = orderEntry
    if (field === '') return undefined

    const column = getModelColumn(model, field)
    if (column === undefined) return undefined
    if (direction === 'asc') {
      return asc(column)
    }
    return desc(column)
  }

  private prepareData(model: ModelName, data: Record<string, unknown>): Record<string, unknown> {
    const prepared: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue
      prepared[field] = this.toDbFieldValue(model, field, value)
    }
    return prepared
  }

  private applyCreateDefaults(model: ModelName, prepared: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = { ...prepared }
    applyModelCreateDefaults(model, output)
    applyTimestampCreateDefaults(model, output)
    return output
  }

  private applyUpdateDefaults(model: ModelName, prepared: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = { ...prepared }
    if (dateColumnsByModel[model].has('updatedAt') && output.updatedAt === undefined) {
      output.updatedAt = new Date().toISOString()
    }
    return output
  }

  private toDbFieldValue(model: ModelName, field: string, value: unknown): unknown {
    if (value === null) return null
    if (value instanceof Date) return value.toISOString()
    if (booleanColumnsByModel[model].has(field)) {
      return Boolean(value)
    }
    return value
  }

  private hydrateRow(model: ModelName, row: Record<string, unknown>): Record<string, unknown> {
    const hydrated: Record<string, unknown> = { ...row }
    for (const [field, value] of Object.entries(hydrated)) {
      hydrated[field] = this.hydrateField(model, field, value)
    }
    return hydrated
  }

  private hydrateField(model: ModelName, field: string, value: unknown): unknown {
    if (value == null) return value

    if (dateColumnsByModel[model].has(field)) {
      return hydrateDateField(value)
    }

    if (booleanColumnsByModel[model].has(field)) {
      return hydrateBooleanField(value)
    }

    return value
  }

  private applySelect(row: Record<string, unknown>, select: SelectInput): Record<string, unknown> {
    const selected: Record<string, unknown> = {}
    for (const [field, enabled] of Object.entries(select)) {
      if (enabled) selected[field] = row[field]
    }
    return selected
  }

  private async applyInclude(
    model: ModelName,
    row: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<Record<string, unknown>> {
    const output: Record<string, unknown> = { ...row }

    if (model === 'user') {
      await this.applyUserInclude(output, include)
      return output
    }

    if (model === 'agent') {
      await this.applyAgentInclude(output, include)
      return output
    }

    if (model === 'vulnerability') {
      await this.applyVulnerabilityInclude(output, include)
      return output
    }

    if (model === 'threatIntelligence') {
      await this.applyThreatIntelligenceInclude(output, include)
      return output
    }

    if (model === 'integration') {
      await this.applyIntegrationInclude(output, include)
      return output
    }

    return output
  }

  private async applyUserInclude(
    output: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<void> {
    if (includeEnabled(include, 'role')) {
      output.role = await this.findNullableRelation('role', output.roleId)
    }
    if (includeEnabled(include, 'status')) {
      output.status = await this.findNullableRelation('status', output.statusId)
    }
  }

  private async findNullableRelation(
    relation: 'role' | 'status',
    id: unknown,
  ): Promise<Record<string, unknown> | null> {
    if (id == null) {
      return null
    }

    return this[relation].findUnique({ where: { id: Number(id) } })
  }

  private async applyAgentInclude(
    output: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<void> {
    const agentId = String(output.id)
    if (includeEnabled(include, 'health')) {
      output.health = await this.agentHealth.findUnique({
        where: { agentId },
      })
    }
    if (includeEnabled(include, 'tags')) {
      output.tags = await this.agentTag.findMany({
        where: { agentId },
      })
    }
  }

  private async applyVulnerabilityInclude(
    output: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<void> {
    const vulnerabilityId = String(output.id)
    if (includeEnabled(include, 'agents')) {
      output.agents = await this.vulnerabilityAgent.findMany({
        where: { vulnerabilityId },
      })
    }
    if (includeEnabled(include, 'timeline')) {
      output.timeline = await this.vulnerabilityTimeline.findMany({
        where: { vulnerabilityId },
        orderBy: this.timelineOrderBy(include.timeline),
      })
    }
  }

  private timelineOrderBy(value: unknown): OrderByInput | undefined {
    if (!isPlainObject(value) || !isPlainObject(value.orderBy)) {
      return undefined
    }

    return value.orderBy as OrderByInput
  }

  private async applyThreatIntelligenceInclude(
    output: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<void> {
    if (!includeEnabled(include, 'indicators')) {
      return
    }

    output.indicators = await this.threatIndicator.findMany({
      where: { threatId: String(output.id) },
    })
  }

  private async applyIntegrationInclude(
    output: Record<string, unknown>,
    include: IncludeInput,
  ): Promise<void> {
    if (!includeEnabled(include, 'healthCheck')) {
      return
    }

    output.healthCheck = await this.integrationHealth.findUnique({
      where: { integrationId: String(output.id) },
    })
  }
}
