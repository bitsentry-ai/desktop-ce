import { z } from "zod";
import {
  errorSourceTypeSchema,
  logLevelThresholdSchema,
} from "../error-sources/error-sources.schemas";
import { globalVariableKeySchema } from "./globals.schemas";
import {
  logFilterConfigSchema,
  runbookIdleTimeoutSchema,
  runbookActionTypeSchema,
  runbookHttpHeaderSchema,
  runbookHttpMethodSchema,
  runbookLlmProviderKeyWithCliSchema,
  telemetryActionConfigWithCliSchema,
} from "./runbooks.schemas";

export const runbookExportedBySchema = z.object({
  product: z.enum(["superterminal", "dashboard"]),
  runtime: z.enum(["desktop", "backend"]),
  appVersion: z.string().optional(),
});

export const exportedRunbookActionParameterV1Schema = z
  .object({
    id: z.string().optional(),
    key: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    defaultValue: z.string().optional(),
    required: z.boolean().optional(),
    secure: z.boolean().optional(),
  })
  .superRefine((parameter, ctx) => {
    if (parameter.secure === true && parameter.defaultValue !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Secure parameters must not store plaintext default values",
        path: ["defaultValue"],
      });
    }
  });

export const exportedRunbookActionV1Schema = z.object({
  id: z.string().optional(),
  type: runbookActionTypeSchema,
  title: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  llmProviderKey: runbookLlmProviderKeyWithCliSchema.optional(),
  llmModel: z.string().optional(),
  url: z.string().optional(),
  method: runbookHttpMethodSchema.optional(),
  headers: z.array(runbookHttpHeaderSchema).optional(),
  body: z.string().optional(),
  pluginId: z.string().optional(),
  pluginActionId: z.string().optional(),
  pluginInput: z.string().optional(),
  pluginAuth: z.string().optional(),
  query: z.string().optional(),
  sourceId: z.string().optional(),
  sourceRef: z.string().optional(),
  sourceName: z.string().optional(),
  sourceType: errorSourceTypeSchema.optional(),
  parameters: z.array(exportedRunbookActionParameterV1Schema).optional(),
  timeout: z.number().int().positive().optional(),
  logFilter: logFilterConfigSchema.optional(),
  telemetryConfig: telemetryActionConfigWithCliSchema.optional(),
});

export const exportedRunbookV1Schema = z.object({
  id: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  idleTimeout: runbookIdleTimeoutSchema.optional(),
  revisionNumber: z.number().int().optional(),
  actions: z.array(exportedRunbookActionV1Schema),
  tags: z.array(z.string()).optional(),
});

export const exportedGlobalVariableV1Schema = z
  .object({
    key: globalVariableKeySchema,
    value: z.string().optional(),
    description: z.string().optional(),
    secure: z.boolean().optional(),
    redacted: z.boolean().optional(),
  })
  .superRefine((global, ctx) => {
    if (global.secure === true && global.value !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Secure globals must not export plaintext values",
        path: ["value"],
      });
    }
  });

export const exportedExternalSourceCredentialsV1Schema = z.object({
  authToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  grantedScopes: z.array(z.string()).optional(),
});

export const exportedExternalSourceV1Schema = z.object({
  ref: z.string(),
  pluginId: z.string().optional(),
  sourceType: errorSourceTypeSchema,
  name: z.string(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  credentials: exportedExternalSourceCredentialsV1Schema.optional(),
  logLevelThreshold: logLevelThresholdSchema.optional(),
  syncEnabled: z.boolean().optional(),
  autoDiagnosisEnabled: z.boolean().optional(),
  credentialsRedacted: z.boolean().optional(),
});

export const runbookExportArtifactV1Schema = z.object({
  format: z.literal("bitsentry.runbooks.export"),
  version: z.literal(1),
  exportedAt: z.string(),
  exportedBy: runbookExportedBySchema.optional(),
  runbooks: z.array(exportedRunbookV1Schema),
  globals: z.array(exportedGlobalVariableV1Schema).optional(),
  externalSources: z.array(exportedExternalSourceV1Schema).optional(),
});

export const exportRunbooksInputSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
  includeGlobals: z.boolean().optional(),
});

export const exportRunbooksOutputSchema = runbookExportArtifactV1Schema;

export const runbookImportOptionsSchema = z.object({
  conflictPolicy: z.enum(["duplicate", "skip", "overwrite"]).optional(),
  preserveIds: z.boolean().optional(),
  includeGlobals: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export const importRunbooksInputSchema = z.object({
  artifact: runbookExportArtifactV1Schema,
  options: runbookImportOptionsSchema.optional(),
});

export const runbookImportResultSchema = z.object({
  title: z.string(),
  status: z.enum(["imported", "skipped", "failed"]),
  runbookId: z.string().optional(),
  reason: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

export const runbookImportSummarySchema = z.object({
  imported: z.number().int().min(0),
  skipped: z.number().int().min(0),
  failed: z.number().int().min(0),
  warnings: z.array(z.string()),
  results: z.array(runbookImportResultSchema),
});

export const importRunbooksOutputSchema = runbookImportSummarySchema;

export type RunbookExportedBy = z.infer<typeof runbookExportedBySchema>;
export type ExportedRunbookActionParameterV1 = z.infer<
  typeof exportedRunbookActionParameterV1Schema
>;
export type ExportedRunbookActionV1 = z.infer<
  typeof exportedRunbookActionV1Schema
>;
export type ExportedRunbookV1 = z.infer<typeof exportedRunbookV1Schema>;
export type ExportedGlobalVariableV1 = z.infer<
  typeof exportedGlobalVariableV1Schema
>;
export type ExportedExternalSourceCredentialsV1 = z.infer<
  typeof exportedExternalSourceCredentialsV1Schema
>;
export type ExportedExternalSourceV1 = z.infer<
  typeof exportedExternalSourceV1Schema
>;
export type RunbookExportArtifactV1 = z.infer<
  typeof runbookExportArtifactV1Schema
>;
export type ExportRunbooksInput = z.infer<typeof exportRunbooksInputSchema>;
export type RunbookImportOptions = z.infer<typeof runbookImportOptionsSchema>;
export type ImportRunbooksInput = z.infer<typeof importRunbooksInputSchema>;
export type RunbookImportResult = z.infer<typeof runbookImportResultSchema>;
export type RunbookImportSummary = z.infer<typeof runbookImportSummarySchema>;
