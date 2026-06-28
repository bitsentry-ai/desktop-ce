import { z } from "zod";
import {
  errorSourceTypeSchema,
  logLevelThresholdSchema,
} from "./error-sources.schemas";

export { errorSourceTypeSchema, logLevelThresholdSchema };

export const syncStatusSchema = z.enum([
  "pending",
  "in_progress",
  "success",
  "failed",
]);

export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type LogLevelThreshold = z.infer<typeof logLevelThresholdSchema>;
export type ErrorSourceType = z.infer<typeof errorSourceTypeSchema>;

export interface ErrorSourceConfiguration {
  orgSlug?: string;
  orgName?: string;
  projectIds?: string[];
  projectSlugs?: string[];
  projectNames?: string[];
  baseUrl?: string;
  indexPatterns?: string[];
  sentryBaseUrl?: string;
  posthogBaseUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRedirectUri?: string;
}

export interface ErrorSource {
  id: string;
  sourceType: ErrorSourceType;
  name: string;
  accessTokenRef: string | null;
  refreshTokenRef: string | null;
  expiresAt: string | null;
  grantedScopes: string[];
  configuration: ErrorSourceConfiguration;
  logLevelThreshold: LogLevelThreshold;
  additionalMetadata: Record<string, unknown> | null;
  syncEnabled: boolean;
  autoDiagnosisEnabled: boolean;
  lastSyncAt: string | null;
  lastSyncStatus: SyncStatus | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ErrorIssue {
  id: string;
  sourceId: string;
  externalIssueId: string;
  externalShortId: string | null;
  title: string;
  culprit: string | null;
  type: string | null;
  metadata: Record<string, unknown> | null;
  projectIdentifier: string | null;
  level: string;
  status: string;
  isUnhandled: boolean | null;
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  userCount: number | null;
  tags: Record<string, unknown> | null;
  environment: string | null;
  release: string | null;
  platform: string | null;
  additionalMetadata: Record<string, unknown> | null;
  diagnosisStatus: string | null;
  diagnosisResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ErrorEvent {
  id: string;
  sourceId: string;
  issueId: string;
  externalEventId: string;
  timestamp: string;
  message: string | null;
  exceptionType: string | null;
  exceptionValue: string | null;
  exceptionMechanism: Record<string, unknown> | null;
  stacktrace: Record<string, unknown> | null;
  inAppFrames: Array<Record<string, unknown>> | null;
  tags: Record<string, unknown> | null;
  contexts: Record<string, unknown> | null;
  userContext: Record<string, unknown> | null;
  requestContext: Record<string, unknown> | null;
  environment: string | null;
  release: string | null;
  serverName: string | null;
  traceId: string | null;
  requestId: string | null;
  transactionName: string | null;
  additionalMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateErrorSourceInput {
  sourceType: ErrorSourceType;
  name: string;
  logLevelThreshold?: LogLevelThreshold;
  additionalMetadata?: Record<string, unknown> | null;
  accessTokenRef?: string | null;
  refreshTokenRef?: string | null;
  expiresAt?: string | null;
  grantedScopes?: string[];
  configuration?: ErrorSourceConfiguration;
  syncEnabled?: boolean;
  autoDiagnosisEnabled?: boolean;
}

export interface UpdateErrorSourceInput {
  id: string;
  name?: string;
  additionalMetadata?: Record<string, unknown> | null;
  accessTokenRef?: string | null;
  refreshTokenRef?: string | null;
  expiresAt?: string | null;
  grantedScopes?: string[];
  configuration?: ErrorSourceConfiguration;
  logLevelThreshold?: LogLevelThreshold;
  syncEnabled?: boolean;
  autoDiagnosisEnabled?: boolean;
  lastSyncAt?: string | null;
  lastSyncStatus?: SyncStatus | null;
  lastSyncError?: string | null;
}

export interface ErrorIssueQuery {
  sourceId: string;
  status?: string;
  level?: string;
  projectIdentifier?: string;
  environment?: string;
  limit?: number;
  offset?: number;
}

export interface ErrorEventQuery {
  sourceId: string;
  issueId?: string;
  level?: string;
  search?: string;
  limit?: number;
  offset?: number;
}
