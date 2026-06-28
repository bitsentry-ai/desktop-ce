import { z } from 'zod';
import {
  OAUTH_PLUGIN_ERROR_SOURCE_TYPES,
} from './plugin-backed-error-sources';

export const errorSourceTypeSchema = z.string().trim().min(1);
export type ErrorSourceType = z.infer<typeof errorSourceTypeSchema>;

export const POSTHOG_DEFAULT_BASE_URL = 'https://us.posthog.com';

export const logLevelThresholdSchema = z.enum([
  'error',
  'warning',
  'info',
  'debug',
]);

export const errorSourceRowSchema = z.object({
  id: z.string(),
  sourceType: errorSourceTypeSchema,
  name: z.string(),
  syncEnabled: z.boolean(),
  autoDiagnosisEnabled: z.boolean(),
  logLevelThreshold: logLevelThresholdSchema,
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastSyncError: z.string().nullable(),
});

export const createPluginErrorSourceSchema = z.object({
  pluginId: z.string().trim().min(1).optional(),
  sourceType: errorSourceTypeSchema,
  name: z.string().trim().min(1),
  setupValues: z.record(z.string(), z.unknown()).optional(),
  authToken: z.string().trim().optional(),
  organizationSlug: z.string().trim().min(1).optional(),
  organizationId: z.string().trim().min(1).optional(),
  projectSlugs: z.array(z.string().trim().min(1)).default([]),
  projectIds: z.array(z.string().trim().min(1)).default([]),
  baseUrl: z.url().optional(),
  posthogBaseUrl: z.url().optional(),
  indexPatterns: z.array(z.string().trim().min(1)).default([]),
  configuration: z.record(z.string(), z.unknown()).optional(),
  additionalMetadata: z.record(z.string(), z.unknown()).optional(),
  logLevelThreshold: logLevelThresholdSchema.default('error'),
  syncEnabled: z.boolean().default(true),
  autoDiagnosisEnabled: z.boolean().default(false),
});

export const createErrorSourceSchema = createPluginErrorSourceSchema;

export const syncErrorSourceSchema = z.object({
  id: z.string().trim().min(1),
  logLevelThreshold: logLevelThresholdSchema,
  syncEnabled: z.boolean(),
});

export const updateErrorSourceSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    logLevelThreshold: logLevelThresholdSchema.optional(),
    syncEnabled: z.boolean().optional(),
    autoDiagnosisEnabled: z.boolean().optional(),
  })
  .refine(
    ({ name, logLevelThreshold, syncEnabled, autoDiagnosisEnabled }) =>
      name !== undefined ||
      logLevelThreshold !== undefined ||
      syncEnabled !== undefined ||
      autoDiagnosisEnabled !== undefined,
    {
      message: 'Provide at least one field to update.',
      path: ['id'],
    },
  );

export const errorSourceSyncResultSchema = z.object({
  sourceId: z.string(),
  syncedIssues: z.number(),
  syncedEvents: z.number(),
  error: z.string().optional(),
});

export const testErrorSourceConnectionResultSchema = z.object({
  success: z.boolean(),
  provider: z.string().trim().min(1),
  organizationCount: z.number(),
  projectCount: z.number(),
});

/**
 * Input schema for the read-only probe procedure. Probing validates a token
 * against a provider's listOrganizations / listProjects endpoints so the UI
 * can render org/project pickers without forcing the user to type slugs.
 *
 * Wazuh is intentionally excluded: it has no org/project concept and a
 * universal probe over an unknown index pattern would behave very differently
 * from the sentry/posthog flow.
 */
export const probeErrorSourceSchema = z.object({
  sourceType: z.enum(OAUTH_PLUGIN_ERROR_SOURCE_TYPES),
  authToken: z.string().trim().min(1),
  baseUrl: z.url().optional(),
  /**
   * Optional org disambiguation. The PostHog create/update flows use
   * `organizationId` as the canonical field; we accept both names here so a
   * backend/dashboard caller can pass the same value through every step of
   * the flow without juggling field names. The service normalizes whichever
   * one is provided into a single slug before fanning out.
   */
  organizationSlug: z.string().trim().min(1).optional(),
  organizationId: z.string().trim().min(1).optional(),
});

export const probeErrorSourceResultSchema = z.object({
  organizations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      orgId: z.string(),
    }),
  ),
});
