import { z } from 'zod';

export const errorSourceTypeSchema = z.string().trim().min(1);
export type ErrorSourceType = z.infer<typeof errorSourceTypeSchema>;

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
  pluginId: z.string().trim().min(1),
  sourceType: errorSourceTypeSchema,
  name: z.string().trim().min(1),
  setupValues: z.record(z.string(), z.unknown()).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  additionalMetadata: z.record(z.string(), z.unknown()).optional(),
  logLevelThreshold: logLevelThresholdSchema.default('error'),
  syncEnabled: z.boolean().default(true),
  autoDiagnosisEnabled: z.boolean().default(true),
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
 * The source type is owned by the installed first-party code plugin. Probing is
 * supported when that plugin declares listOrganizations/listProjects actions.
 */
export const probeErrorSourceSchema = z.object({
  pluginId: z.string().trim().min(1),
  sourceType: errorSourceTypeSchema,
  setupValues: z.record(z.string(), z.unknown()).optional(),
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
