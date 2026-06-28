import { z } from "zod";
import { errorSourceTypeSchema } from "../error-sources/error-sources.schemas";
import { globalVariableKeySchema } from "./globals.schemas";

// Action type enums
export const runbookActionTypeSchema = z.enum([
  "shell",
  "llm",
  "http",
  "plugin",
  "external_source",
  "telemetry_existing_entry",
  "data_source_query",
  "telemetry_ingest",
  "diagnosis_diagnose",
  "diagnosis_verify",
  "diagnosis_recommend",
]);

export const runbookHttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export const runbookLlmProviderKeySchema = z.enum([
  "groq",
  "kilocode",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
]);

// Extended schema that includes desktop-only CLI providers (for import/export compatibility)
export const runbookLlmProviderKeyWithCliSchema = z.enum([
  "groq",
  "kilocode",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "claude_code",
  "codex",
  "opencode",
  "cursor",
]);

export const runbookExecutionAccessLevelSchema = z.enum([
  "supervised",
  "auto-accept-edits",
  "full-access",
]);

// Header schema
export const runbookHttpHeaderSchema = z.object({
  key: z.string(),
  value: z.string(),
});

export const runbookActionParameterSchema = z
  .object({
    id: z.string(),
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

const logFilterNamedGroupPattern = /\(\?<[$A-Z_a-z][$\w]*>/;

export const logFilterConfigSchema = z
  .object({
    type: z.literal("regex").optional(),
    pattern: z.string().trim().min(1),
    flags: z
      .string()
      .regex(/^[imsu]*$/, "Only i, m, s, and u regex flags are supported")
      .optional(),
    multiline: z.boolean().optional(),
    match: z.enum(["first", "all"]).optional(),
    maxMatches: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((config, ctx) => {
    if (!logFilterNamedGroupPattern.test(config.pattern)) {
      ctx.addIssue({
        code: "custom",
        message:
          "Log filter pattern must include at least one named capture group",
        path: ["pattern"],
      });
    }

    const rawFlags = config.flags ?? "";
    const flags = new Set(rawFlags.split(""));
    if (flags.size !== rawFlags.length) {
      ctx.addIssue({
        code: "custom",
        message: "Log filter regex flags must not contain duplicates",
        path: ["flags"],
      });
    }

    if (config.multiline === true) {
      flags.add("m");
    }

    try {
      new RegExp(config.pattern, [...flags].join(""));
    } catch (error) {
      let message = "Invalid log filter regex";
      if (error instanceof Error) {
        message = `Invalid log filter regex: ${error.message}`;
      }
      ctx.addIssue({
        code: "custom",
        message,
        path: ["pattern"],
      });
    }
  });

export const telemetryNeedOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const runbookTriggerSurfaceSchema = z.enum([
  "runbooks",
  "incident_detail",
  "incident_workspace",
  "diagnosis",
]);

export const telemetryQueryModeSchema = z.enum(["search", "collector"]);
export const runbookIdleTimeoutSchema = z.number().int().min(0).max(1440);
export const runbookExecutionSourceSchema = z.enum(["manual", "agent"]);
export const runbookExecutionCompletionReasonSchema = z.enum([
  "success",
  "step_failed",
  "user_cancelled",
  "idle_timeout",
  "app_shutdown",
  "lease_expired",
]);

export const runbookTriggerContextSchema = z.object({
  needId: z.string().trim().min(1).optional(),
  needLabel: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  sourceName: z.string().trim().min(1).optional(),
  sourceType: errorSourceTypeSchema.optional(),
  entrypoint: runbookTriggerSurfaceSchema,
  incidentThreadId: z.string().trim().min(1).optional(),
});

export const telemetryActionConfigSchema = z.object({
  needId: z.string().trim().min(1).optional(),
  needLabel: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  sourceType: errorSourceTypeSchema.optional(),
  sourceName: z.string().trim().min(1).optional(),
  queryMode: telemetryQueryModeSchema.optional(),
  queryLimit: z.number().int().min(1).max(100).optional(),
  queryText: z.string().trim().min(1).optional(),
  collectionDate: z.string().trim().min(1).optional(),
  include: z.string().trim().min(1).optional(),
  exclude: z.string().trim().min(1).optional(),
  indexPattern: z.string().trim().min(1).optional(),
  telemetryEntryIds: z.array(z.number().int().positive()).optional(),
  diagnosisEntryIds: z.array(z.number().int().positive()).optional(),
  llmProviderKey: runbookLlmProviderKeySchema.optional(),
  llmModel: z.string().optional(),
  entrypoint: runbookTriggerSurfaceSchema.optional(),
});

export const telemetryActionConfigWithCliSchema = z.object({
  needId: z.string().trim().min(1).optional(),
  needLabel: z.string().trim().min(1).optional(),
  sourceId: z.string().trim().min(1).optional(),
  sourceType: errorSourceTypeSchema.optional(),
  sourceName: z.string().trim().min(1).optional(),
  queryMode: telemetryQueryModeSchema.optional(),
  queryLimit: z.number().int().min(1).max(100).optional(),
  queryText: z.string().trim().min(1).optional(),
  collectionDate: z.string().trim().min(1).optional(),
  include: z.string().trim().min(1).optional(),
  exclude: z.string().trim().min(1).optional(),
  indexPattern: z.string().trim().min(1).optional(),
  telemetryEntryIds: z.array(z.number().int().positive()).optional(),
  diagnosisEntryIds: z.array(z.number().int().positive()).optional(),
  llmProviderKey: runbookLlmProviderKeyWithCliSchema.optional(),
  llmModel: z.string().optional(),
  entrypoint: runbookTriggerSurfaceSchema.optional(),
});

// Action schemas
export const runbookActionRecordSchema = z.object({
  id: z.string(),
  type: runbookActionTypeSchema,
  title: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  llmProviderKey: runbookLlmProviderKeySchema.optional(),
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
  parameters: z.array(runbookActionParameterSchema).optional(),
  logFilter: logFilterConfigSchema.optional(),
  telemetryConfig: telemetryActionConfigSchema.optional(),
});

// Input action schema (id is optional for create/update operations)
export const runbookActionInputSchema = z.object({
  id: z.string().optional(),
  type: runbookActionTypeSchema,
  title: z.string(),
  command: z.string().optional(),
  prompt: z.string().optional(),
  llmProviderKey: runbookLlmProviderKeySchema.optional(),
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
  parameters: z.array(runbookActionParameterSchema).optional(),
  logFilter: logFilterConfigSchema.optional(),
  telemetryConfig: telemetryActionConfigSchema.optional(),
});

// Runbook schemas
export const runbookRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  idleTimeout: runbookIdleTimeoutSchema.optional(),
  revisionNumber: z.number(),
  actions: z.array(runbookActionRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const runbookGlobalReferenceSchema = z.object({
  key: globalVariableKeySchema,
  secure: z.boolean().optional(),
  description: z.string().optional(),
});

export const runbookResolvedGlobalsSchema = z.object({
  values: z.record(z.string(), z.string()),
  definitions: z.array(runbookGlobalReferenceSchema),
});

// Context export schema
export const runbookContextSchema = z.object({
  format: z.literal("bitsentry.runbook.context"),
  version: z.literal(1),
  runbook: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    idleTimeout: runbookIdleTimeoutSchema.optional(),
    revisionNumber: z.number(),
    updatedAt: z.string(),
    actionCount: z.number(),
  }),
  summary: z.object({
    purposeText: z.string(),
    actionTypeCounts: z.record(runbookActionTypeSchema, z.number()),
    orderedActionTitles: z.array(z.string()),
  }),
  globalReferences: z.array(runbookGlobalReferenceSchema).optional(),
  executionContext: runbookTriggerContextSchema.optional(),
  actions: z.array(
    z.object({
      id: z.string(),
      order: z.number(),
      type: runbookActionTypeSchema,
      title: z.string(),
      payload: z.object({
        command: z.string().optional(),
        prompt: z.string().optional(),
        llmProviderKey: runbookLlmProviderKeySchema.optional(),
        llmModel: z.string().optional(),
        url: z.string().optional(),
        method: runbookHttpMethodSchema.optional(),
        headers: z.array(runbookHttpHeaderSchema).optional(),
        body: z.string().optional(),
        query: z.string().optional(),
        sourceId: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: logFilterConfigSchema.optional(),
        telemetryConfig: telemetryActionConfigSchema.optional(),
      }),
    }),
  ),
});

// Input/Output schemas for API operations
export const listRunbooksOutputSchema = z.array(runbookRecordSchema);

export const getRunbookInputSchema = z.object({
  id: z.string(),
});

export const getRunbookOutputSchema = runbookRecordSchema.nullable();

export const createRunbookInputSchema = z.object({
  title: z.string(),
  description: z.string(),
  idleTimeout: runbookIdleTimeoutSchema.optional(),
  actions: z.array(runbookActionInputSchema).optional(),
});

export const createRunbookOutputSchema = runbookRecordSchema;

export const updateRunbookMetadataInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  idleTimeout: runbookIdleTimeoutSchema.optional(),
});

export const updateRunbookMetadataOutputSchema = runbookRecordSchema.nullable();

export const updateRunbookActionsInputSchema = z.object({
  id: z.string(),
  actions: z.array(runbookActionInputSchema),
});

export const updateRunbookActionsOutputSchema = runbookRecordSchema.nullable();

export const saveRunbookActionInputSchema = z.object({
  runbookId: z.string(),
  action: runbookActionRecordSchema.extend({
    sortOrder: z.number().int().min(0).optional(),
  }),
});

export const saveRunbookActionOutputSchema = runbookRecordSchema.nullable();

export const deleteRunbookActionInputSchema = z.object({
  runbookId: z.string(),
  actionId: z.string(),
});

export const deleteRunbookActionOutputSchema = runbookRecordSchema.nullable();

export const reorderRunbookActionsInputSchema = z.object({
  runbookId: z.string(),
  actionIdsInOrder: z.array(z.string()),
});

export const reorderRunbookActionsOutputSchema = runbookRecordSchema.nullable();

export const deleteRunbookInputSchema = z.object({
  id: z.string(),
});

export const deleteRunbookOutputSchema = z.object({
  deleted: z.boolean(),
});

export const exportRunbookContextInputSchema = z.object({
  id: z.string(),
});

export const exportRunbookContextOutputSchema = runbookContextSchema.nullable();

// Execution status enum
export const executionStatusSchema = z.enum([
  "queued",
  "pending",
  "running",
  "claim_expired",
  "completed",
  "failed",
  "cancelled",
]);

// Execution step status enum
export const executionStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

// Execution step schema
export const executionStepSchema = z.object({
  actionId: z.string(),
  order: z.number(),
  type: runbookActionTypeSchema,
  title: z.string(),
  status: executionStepStatusSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  exitCode: z.number().optional(),
  statusCode: z.number().optional(),
  streamDeltas: z
    .array(
      z.object({
        timestamp: z.string(),
        text: z.string(),
        kind: z.enum(["text", "command_output"]).optional(),
      }),
    )
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  structuredOutput: z.record(z.string(), z.unknown()).optional(),
});

// Execution summary schema (for list view)
export const executionSummarySchema = z.object({
  executionId: z.string(),
  runbookId: z.string(),
  incidentThreadId: z.string().optional(),
  runbookTitle: z.string(),
  status: executionStatusSchema,
  snapshotVersion: z.number().int().nonnegative().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  completionReason: runbookExecutionCompletionReasonSchema.optional(),
  idleTimeoutMinutes: runbookIdleTimeoutSchema.optional(),
  lastActivityAt: z.string().optional(),
  stepCount: z.number(),
  completedStepCount: z.number(),
  source: runbookExecutionSourceSchema.optional(),
  triggerContext: runbookTriggerContextSchema.optional(),
  currentActionLabel: z.string().optional(),
  providerUsed: runbookLlmProviderKeySchema.optional(),
  modelUsed: z.string().optional(),
  failureReason: z.string().optional(),
  telemetryEntryIds: z.array(z.number().int().positive()).optional(),
  diagnosisEntryIds: z.array(z.number().int().positive()).optional(),
});

// Execution detail schema (for detail view)
export const executionDetailSchema = z.object({
  executionId: z.string(),
  runbookId: z.string(),
  incidentThreadId: z.string().optional(),
  runbookTitle: z.string(),
  status: executionStatusSchema,
  snapshotVersion: z.number().int().nonnegative().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  completionReason: runbookExecutionCompletionReasonSchema.optional(),
  idleTimeoutMinutes: runbookIdleTimeoutSchema.optional(),
  lastActivityAt: z.string().optional(),
  parameterValues: z.record(z.string(), z.string()).optional(),
  source: runbookExecutionSourceSchema,
  triggerContext: runbookTriggerContextSchema.optional(),
  steps: z.array(executionStepSchema),
});

// Execute runbook input schema
export const executeRunbookInputSchema = z.object({
  runbookId: z.string(),
  parameterValues: z.record(z.string(), z.string()).optional(),
  incidentThreadId: z.string().optional(),
  accessLevel: runbookExecutionAccessLevelSchema.optional(),
  triggerContext: runbookTriggerContextSchema.optional(),
});

// Execute runbook output schema
export const executeRunbookOutputSchema = z.object({
  executionId: z.string(),
  resultId: z.string(),
});

export const continueDiagnosisRunbookInputSchema = z.object({
  diagnosisId: z.number().int().positive(),
  telemetryEntryId: z.number().int().positive().optional(),
  sourceId: z.string().trim().min(1).optional(),
  incidentThreadId: z.string().trim().min(1).optional(),
  llmProviderKey: runbookLlmProviderKeySchema.optional(),
  llmModel: z.string().trim().min(1).optional(),
});

export const continueDiagnosisRunbookOutputSchema = executeRunbookOutputSchema;

// Get execution input schema
export const getExecutionInputSchema = z.object({
  executionId: z.string(),
});

// Get execution output schema
export const getExecutionOutputSchema = executionDetailSchema.nullable();

// Cancel execution input schema
export const cancelExecutionInputSchema = z.object({
  executionId: z.string(),
});

// Cancel execution output schema
export const cancelExecutionOutputSchema = z.object({
  cancelled: z.boolean(),
});

// List executions input schema (with optional filters)
export const listExecutionsInputSchema = z.object({
  status: executionStatusSchema.optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
  runbookId: z.string().optional(),
});

// List executions output schema
export const listExecutionsOutputSchema = z.object({
  executions: z.array(executionSummarySchema),
  total: z.number(),
  hasMore: z.boolean(),
});

export const listTelemetryNeedsOutputSchema = z.array(
  telemetryNeedOptionSchema,
);

export const listTelemetryActivityInputSchema = z.object({
  status: executionStatusSchema.optional(),
  limit: z.number().optional().default(25),
  offset: z.number().optional().default(0),
});

export const listTelemetryActivityOutputSchema = z.object({
  executions: z.array(executionSummarySchema),
  total: z.number(),
  hasMore: z.boolean(),
});

export const getLinkedTelemetryExecutionInputSchema = z
  .object({
    diagnosisId: z.number().int().positive().optional(),
    telemetryEntryId: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      typeof input.diagnosisId === "number" ||
      typeof input.telemetryEntryId === "number",
    {
      message: "diagnosisId or telemetryEntryId is required",
      path: ["diagnosisId"],
    },
  );

export const getLinkedTelemetryExecutionOutputSchema =
  executionSummarySchema.nullable();

export const runbookWorkerCancelExecutionRequestSchema = z.object({
  executionId: z.string(),
});

export const runbookWorkerClaimNextExecutionRequestSchema = z.object({
  runtimeId: z.string().trim().min(1),
});

export const runbookWorkerHeartbeatRequestSchema = z.object({
  executionId: z.string(),
  runtimeId: z.string().trim().min(1),
  claimToken: z.string().trim().min(1),
});

export const runbookWorkerAcceptedResponseSchema = z.object({
  accepted: z.boolean(),
});

export const runbookWorkerExecutionContextResponseSchema = z.object({
  executionId: z.string(),
  userId: z.number().int(),
  runbookId: z.string(),
  incidentThreadId: z.string().nullable().optional(),
  runbookTitle: z.string(),
  claimToken: z.string().trim().min(1),
  parameterValues: z.record(z.string(), z.string()).optional(),
  snapshot: executionDetailSchema,
  context: runbookContextSchema,
  resolvedGlobals: runbookResolvedGlobalsSchema,
});

export const runbookWorkerSnapshotUpdateRequestSchema = z.object({
  snapshot: executionDetailSchema,
  runtimeId: z.string().trim().min(1),
  claimToken: z.string().trim().min(1),
});

export type RunbookContextV1 = z.infer<typeof runbookContextSchema>;
export type RunbookGlobalReference = z.infer<
  typeof runbookGlobalReferenceSchema
>;
export type RunbookResolvedGlobals = z.infer<
  typeof runbookResolvedGlobalsSchema
>;
export type RunbookActionType = z.infer<typeof runbookActionTypeSchema>;
export type RunbookHttpMethod = z.infer<typeof runbookHttpMethodSchema>;
export type RunbookLlmProviderKey = z.infer<typeof runbookLlmProviderKeySchema>;
export type RunbookLlmProviderKeyWithCli = z.infer<
  typeof runbookLlmProviderKeyWithCliSchema
>;
export type RunbookHttpHeader = z.infer<typeof runbookHttpHeaderSchema>;
export type RunbookActionParameter = z.infer<
  typeof runbookActionParameterSchema
>;
export type LogFilterConfig = z.infer<typeof logFilterConfigSchema>;
export type RunbookActionRecord = z.infer<typeof runbookActionRecordSchema>;
export type RunbookRecord = z.infer<typeof runbookRecordSchema>;
export type RunbookExecutionStepRecord = z.infer<typeof executionStepSchema>;
export type RunbookExecutionRecord = z.infer<typeof executionDetailSchema>;
export type RunbookTriggerContext = z.infer<typeof runbookTriggerContextSchema>;
export type TelemetryActionConfig = z.infer<typeof telemetryActionConfigSchema>;
export type TelemetryActionConfigWithCli = z.infer<
  typeof telemetryActionConfigWithCliSchema
>;
export type TelemetryNeedOption = z.infer<typeof telemetryNeedOptionSchema>;
