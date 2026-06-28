import { z } from "zod";
import { DESKTOP_RPC_CHANNELS, type DesktopRpcChannel } from "./desktop-ipc-contract";

type DesktopIpcEnumValues = readonly [string, ...string[]];

const DESKTOP_CE_LLM_PROVIDER_KEYS = [
  "claude_code",
  "codex",
  "opencode",
  "cursor",
] as const satisfies DesktopIpcEnumValues;

const DESKTOP_PRO_LLM_PROVIDER_KEYS = [
  "groq",
  "kilocode",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  ...DESKTOP_CE_LLM_PROVIDER_KEYS,
] as const satisfies DesktopIpcEnumValues;

const DESKTOP_CE_TELEMETRY_ACTION_TYPES = [
  "telemetry_existing_entry",
  "data_source_query",
  "telemetry_ingest",
] as const satisfies DesktopIpcEnumValues;

const DESKTOP_PRO_TELEMETRY_ACTION_TYPES = [
  ...DESKTOP_CE_TELEMETRY_ACTION_TYPES,
  "diagnosis_diagnose",
  "diagnosis_verify",
  "diagnosis_recommend",
] as const satisfies DesktopIpcEnumValues;

export interface DesktopIpcPayloadSchemaConfig {
  llmProviderKeys: DesktopIpcEnumValues;
  telemetryActionTypes: DesktopIpcEnumValues;
  exportRunbooksInputSchema: z.ZodObject;
  runbookImportOptionsSchema: z.ZodType;
  logFilterConfigSchema: z.ZodType;
  telemetryActionConfigSchema: z.ZodType;
  importFromFileOptionsRequired?: boolean;
}

export interface DesktopEditionIpcPayloadSchemaConfig
  extends Omit<
    DesktopIpcPayloadSchemaConfig,
    "llmProviderKeys" | "telemetryActionTypes"
  > {
  edition: "ce" | "pro";
}

export function createDesktopEditionIpcPayloadValidator(
  config: DesktopEditionIpcPayloadSchemaConfig,
): (channel: DesktopRpcChannel, payload: unknown) => unknown {
  const { edition, ...rest } = config;
  let llmProviderKeys: DesktopIpcEnumValues = DESKTOP_CE_LLM_PROVIDER_KEYS;
  let telemetryActionTypes: DesktopIpcEnumValues = DESKTOP_CE_TELEMETRY_ACTION_TYPES;
  if (edition === "pro") {
    llmProviderKeys = DESKTOP_PRO_LLM_PROVIDER_KEYS;
    telemetryActionTypes = DESKTOP_PRO_TELEMETRY_ACTION_TYPES;
  }

  return createDesktopIpcPayloadValidator({
    ...rest,
    llmProviderKeys,
    telemetryActionTypes,
  });
}

export function createDesktopIpcPayloadValidator(
  config: DesktopIpcPayloadSchemaConfig,
): (channel: DesktopRpcChannel, payload: unknown) => unknown {
  const looseObjectSchema = z.looseObject({});
  const optionalLooseObjectSchema = looseObjectSchema.optional().default({});
  const idSchema = z.object({ id: z.string().min(1) });
  const dialogFilterSchema = z.object({
    name: z.string().min(1),
    extensions: z.array(z.string().min(1)).min(1),
  });
  const saveDialogTrustScopeSchema = z.enum(["runbooks-export"]);
  const openDialogTrustScopeSchema = z.enum(["runbooks-import"]);
  const openDialogPropertySchema = z.enum([
    "openFile",
    "openDirectory",
    "multiSelections",
    "showHiddenFiles",
    "createDirectory",
    "promptToCreate",
    "noResolveAliases",
    "treatPackageAsDirectory",
    "dontAddToRecent",
  ]);
  const runbookActionParameterSchema = z.object({
    id: z.string().min(1),
    key: z.string(),
    label: z.string().optional(),
    description: z.string().optional(),
    defaultValue: z.string().optional(),
    required: z.boolean().optional(),
    secure: z.boolean().optional(),
  });
  const runbookTriggerContextSchema = z.object({
    entrypoint: z.enum([
      "runbooks",
      "incident_detail",
      "incident_workspace",
      "diagnosis",
    ]),
    needId: z.string().optional(),
    needLabel: z.string().optional(),
    sourceId: z.string().optional(),
    sourceName: z.string().optional(),
    sourceType: z.enum(["sentry", "wazuh", "posthog"]).optional(),
    incidentThreadId: z.string().optional(),
  });
  const runbookIdleTimeoutSchema = z.number().int().min(0).max(1440);
  const telemetryRunbookActionSchema = z.object({
    id: z.string().min(1),
    sortOrder: z.number().int().min(0).optional(),
    type: z.enum(config.telemetryActionTypes),
    title: z.string(),
    body: z.string().optional(),
    query: z.string().optional(),
    sourceId: z.string().optional(),
    parameters: z.array(runbookActionParameterSchema).optional(),
    logFilter: config.logFilterConfigSchema.optional(),
    telemetryConfig: config.telemetryActionConfigSchema.optional(),
  });
  const desktopRunbookLlmProviderKeySchema = z.enum(config.llmProviderKeys);

  function createDesktopRunbookActionSchema(idValueSchema: z.ZodType) {
    const telemetryActionSchema = telemetryRunbookActionSchema.extend({
      id: idValueSchema,
    });

    return z.discriminatedUnion("type", [
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("shell"),
        title: z.string(),
        command: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("ai"),
        title: z.string(),
        prompt: z.string().optional(),
        llmProviderKey: desktopRunbookLlmProviderKeySchema.optional(),
        llmModel: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("llm"),
        title: z.string(),
        prompt: z.string().optional(),
        llmProviderKey: desktopRunbookLlmProviderKeySchema.optional(),
        llmModel: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("http"),
        title: z.string(),
        url: z.string().optional(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
            }),
          )
          .optional(),
        body: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("plugin"),
        title: z.string(),
        pluginId: z.string().min(1),
        pluginActionId: z.string().min(1),
        pluginInput: z.string().optional(),
        pluginAuth: z.string().optional(),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      z.object({
        id: idValueSchema,
        sortOrder: z.number().int().min(0).optional(),
        type: z.literal("external_source"),
        title: z.string(),
        query: z.string().min(1),
        sourceId: z.string().min(1),
        parameters: z.array(runbookActionParameterSchema).optional(),
        logFilter: config.logFilterConfigSchema.optional(),
      }),
      telemetryActionSchema,
    ]);
  }

  const desktopRunbookActionSchema = createDesktopRunbookActionSchema(
    z.string().min(1),
  );
  const desktopRunbookActionInputSchema = createDesktopRunbookActionSchema(
    z.string().min(1).optional(),
  );

  const llmSchema = z
    .object({
      providerKey: desktopRunbookLlmProviderKeySchema.optional(),
      model: z.string().min(1).max(200).optional(),
      thinkingEnabled: z.boolean().optional(),
    })
    .optional();

  const attachmentSchema = z.object({
    id: z.string().min(1),
    type: z.literal("image"),
    name: z.string().min(1).max(255),
    mimeType: z.string().regex(/^image\//i),
    sizeBytes: z.number().int().positive().max(3 * 1024 * 1024),
    dataUrl: z.string().min(1).max(5 * 1024 * 1024),
  });

  const runbookImportSchema = z.object({
    artifact: z.unknown(),
    options: config.runbookImportOptionsSchema.optional(),
  });
  let importFromFileOptionsSchema: z.ZodType =
    config.runbookImportOptionsSchema.optional();
  if (config.importFromFileOptionsRequired) {
    importFromFileOptionsSchema = config.runbookImportOptionsSchema;
  }

  const runbookImportFromFileSchema = z.object({
    filePath: z.string().min(1),
    options: importFromFileOptionsSchema,
  });

  const schemaOverrides: Partial<Record<DesktopRpcChannel, z.ZodType>> = {
    "plugins:get": z.object({
      pluginId: z.string().min(1),
    }),
    "plugins:getStoredAuth": z.object({
      pluginId: z.string().min(1),
    }),
    "plugins:updateStoredAuth": z.object({
      pluginId: z.string().min(1),
      auth: z.record(z.string(), z.unknown()),
    }),
    "plugins:clearStoredAuth": z.object({
      pluginId: z.string().min(1),
    }),
    "plugins:execute": z.object({
      pluginId: z.string().min(1),
      actionId: z.string().min(1),
      auth: z.record(z.string(), z.unknown()).optional(),
      input: z.record(z.string(), z.unknown()).optional(),
    }),
    "errorSources:create": z.object({
      pluginId: z.string().min(1).optional(),
      sourceType: z.string().min(1),
      name: z.string().min(1),
      setupValues: z.record(z.string(), z.unknown()).optional(),
      authToken: z.string().min(1).optional(),
      organizationSlug: z.string().min(1).optional(),
      projectSlugs: z.array(z.string().min(1)).optional(),
      sentryBaseUrl: z.url().optional(),
      organizationId: z.string().min(1).optional(),
      projectIds: z.array(z.string().min(1)).optional(),
      baseUrl: z.url().optional(),
      posthogBaseUrl: z.url().optional(),
      indexPatterns: z.array(z.string().min(1)).optional(),
      configuration: z.record(z.string(), z.unknown()).optional(),
      additionalMetadata: z.record(z.string(), z.unknown()).optional(),
      logLevelThreshold: z
        .enum(["error", "warning", "info", "debug"])
        .optional(),
      syncEnabled: z.boolean().optional(),
      autoDiagnosisEnabled: z.boolean().optional(),
    }),
    "errorSources:update": z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      setupValues: z.record(z.string(), z.unknown()).optional(),
      configuration: z.record(z.string(), z.unknown()).optional(),
      additionalMetadata: z.record(z.string(), z.unknown()).optional(),
      organizationSlug: z.string().min(1).optional(),
      organizationId: z.string().min(1).optional(),
      projectSlugs: z.array(z.string().min(1)).optional(),
      projectIds: z.array(z.string().min(1)).optional(),
      sentryBaseUrl: z.url().optional(),
      baseUrl: z.url().optional(),
      posthogBaseUrl: z.url().optional(),
      logLevelThreshold: z
        .enum(["error", "warning", "info", "debug"])
        .optional(),
      syncEnabled: z.boolean().optional(),
      autoDiagnosisEnabled: z.boolean().optional(),
    }),
    "errorSources:initiateOAuth": z
      .object({
        pluginId: z.string().min(1).optional(),
        sourceType: z.string().min(1).optional(),
        setupValues: z.record(z.string(), z.unknown()).optional(),
        clientId: z.string().min(1).optional(),
        redirectUri: z.string().min(1).optional(),
        baseUrl: z.url().optional(),
        posthogBaseUrl: z.url().optional(),
      })
      .optional()
      .default({}),
    "errorSources:completeOAuth": z.object({
      pluginId: z.string().min(1).optional(),
      sourceType: z.string().min(1).optional(),
      setupValues: z.record(z.string(), z.unknown()).optional(),
      code: z.string().min(1),
      state: z.string().min(1),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      redirectUri: z.string().min(1).optional(),
      name: z.string().optional(),
      orgSlug: z.string().optional(),
      organizationId: z.string().optional(),
      projectSlugs: z.array(z.string()).optional(),
      projectIds: z.array(z.string()).optional(),
      baseUrl: z.url().optional(),
      posthogBaseUrl: z.url().optional(),
      syncEnabled: z.boolean().optional(),
      autoDiagnosisEnabled: z.boolean().optional(),
    }),
    "errorSources:testConnection": z.object({
      id: z.string().min(1),
    }),
    "errorSources:probeConnection": z.object({
      pluginId: z.string().min(1).optional(),
      sourceType: z.enum(["sentry", "posthog"]),
      authToken: z.string().min(1),
      baseUrl: z.url().optional(),
      posthogBaseUrl: z.url().optional(),
      organizationSlug: z.string().min(1).optional(),
      organizationId: z.string().min(1).optional(),
    }),
    "errorSources:triggerSync": z
      .object({
        id: z.string().optional(),
      })
      .optional()
      .default({}),
    "errorIssues:list": z.object({
      sourceId: z.string().min(1),
      status: z.string().optional(),
      level: z.string().optional(),
      projectIdentifier: z.string().optional(),
      environment: z.string().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    }),
    "errorEvents:list": z.object({
      sourceId: z.string().min(1),
      issueId: z.string().min(1).optional(),
      level: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().min(0).optional(),
    }),
    "errorEvents:getOne": z.object({
      id: z.string().min(1),
    }),
    "settings:updateGeneral": z.object({
      data: looseObjectSchema,
      userId: z.number().int().positive().optional(),
    }),
    "settings:updateSecurity": z.object({
      data: looseObjectSchema,
      userId: z.number().int().positive().optional(),
    }),
    "settings:updateNotifications": z.object({
      data: looseObjectSchema,
      userId: z.number().int().positive().optional(),
    }),
    "globals:create": z.object({
      key: z.string().min(1),
      value: z.string().optional(),
      description: z.string().optional(),
      secure: z.boolean().optional(),
    }),
    "globals:update": z.object({
      id: z.string().min(1),
      patch: z.object({
        key: z.string().min(1).optional(),
        value: z.string().optional(),
        description: z.string().optional(),
        secure: z.boolean().optional(),
      }),
    }),
    "globals:delete": z.object({
      id: z.string().min(1),
    }),
    "settings:createAlertRule": z.object({
      rule: looseObjectSchema,
      userId: z.number().int().positive().optional(),
    }),
    "settings:updateAlertRule": z.object({
      ruleId: z.string().min(1),
      data: looseObjectSchema,
      userId: z.number().int().positive().optional(),
    }),
    "settings:deleteAlertRule": z.object({
      ruleId: z.string().min(1),
    }),
    "settings:initializeDefaults": z
      .object({
        userId: z.number().int().positive().optional(),
      })
      .optional()
      .default({}),
    "agent:start": z.looseObject({
      prompt: z.string().min(1).max(10000),
      timeoutMs: z.number().int().positive().max(300000).optional(),
      attachments: z.array(attachmentSchema).max(4).optional(),
      llm: llmSchema,
      accessLevel: z
        .enum(["supervised", "auto-accept-edits", "full-access"])
        .optional(),
    }),
    "agent:send": z.looseObject({
      message: z.string().min(1).max(10000),
      sessionId: z.uuid().optional(),
      attachments: z.array(attachmentSchema).max(4).optional(),
      llm: llmSchema,
      accessLevel: z
        .enum(["supervised", "auto-accept-edits", "full-access"])
        .optional(),
    }),
    "agent:cancel": z.object({
      sessionId: z.uuid(),
    }),
    "agent:getStatus": z.object({
      sessionId: z.uuid(),
    }),
    "agent:getSnapshot": z.object({
      sessionId: z.uuid(),
    }),
    "dialog:showSaveDialog": z
      .object({
        defaultPath: z.string().min(1).optional(),
        defaultFileName: z.string().min(1).optional(),
        filters: z.array(dialogFilterSchema).optional(),
        trustScope: saveDialogTrustScopeSchema.optional(),
      })
      .optional()
      .default({}),
    "dialog:showOpenDialog": z
      .object({
        defaultPath: z.string().min(1).optional(),
        filters: z.array(dialogFilterSchema).optional(),
        properties: z.array(openDialogPropertySchema).optional(),
        trustScope: openDialogTrustScopeSchema.optional(),
      })
      .optional()
      .default({}),
    "runbooks:list": optionalLooseObjectSchema,
    "runbooks:get": idSchema,
    "runbooks:create": z.object({
      id: z.uuid(),
      title: z.string().min(1),
      description: z.string().optional(),
      idleTimeout: runbookIdleTimeoutSchema.optional(),
    }),
    "runbooks:updateMeta": z.object({
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      idleTimeout: runbookIdleTimeoutSchema.optional(),
    }),
    "runbooks:updateActions": z.object({
      runbookId: z.string().min(1),
      actions: z.array(desktopRunbookActionInputSchema),
    }),
    "runbooks:saveAction": z.object({
      runbookId: z.string().min(1),
      action: desktopRunbookActionSchema,
    }),
    "runbooks:deleteAction": z.object({
      runbookId: z.string().min(1),
      actionId: z.string().min(1),
    }),
    "runbooks:reorderActions": z.object({
      runbookId: z.string().min(1),
      actionIdsInOrder: z.array(z.string().min(1)),
    }),
    "runbooks:delete": idSchema,
    "runbooks:exportContext": idSchema,
    "runbooks:export": config.exportRunbooksInputSchema,
    "runbooks:exportToFile": config.exportRunbooksInputSchema.extend({
      filePath: z.string().min(1),
    }),
    "runbooks:import": runbookImportSchema,
    "runbooks:readImportArtifact": z.object({
      filePath: z.string().min(1),
    }),
    "runbooks:importFromFile": runbookImportFromFileSchema,
    "runbooks:execute": z.object({
      runbookId: z.string().min(1),
      parameterValues: z.record(z.string(), z.string()).optional(),
      incidentThreadId: z.string().optional(),
      accessLevel: z
        .enum(["supervised", "auto-accept-edits", "full-access"])
        .optional(),
      triggerContext: runbookTriggerContextSchema.optional(),
    }),
    "runbooks:getExecution": z.object({
      executionId: z.uuid(),
    }),
    "runbooks:cancelExecution": z.object({
      executionId: z.uuid(),
    }),
    "incidents:getState": optionalLooseObjectSchema,
    "incidents:replaceState": optionalLooseObjectSchema,
    "desktopState:bootstrap": optionalLooseObjectSchema,
    "desktopState:syncIncidents": optionalLooseObjectSchema,
    "desktopState:syncRunbooks": optionalLooseObjectSchema,
    "desktopState:syncResults": optionalLooseObjectSchema,
  };

  const noPayloadChannels: DesktopRpcChannel[] = [
    "plugins:list",
    "settings:getAll",
    "settings:getGeneral",
    "settings:getSecurity",
    "settings:getNotifications",
    "globals:list",
    "settings:getAlertRules",
  ];

  for (const channel of noPayloadChannels) {
    schemaOverrides[channel] = optionalLooseObjectSchema;
  }

  const idOnlyChannels: DesktopRpcChannel[] = [
    "errorSources:getOne",
    "errorSources:delete",
    "errorSources:testConnection",
    "errorEvents:getOne",
  ];

  for (const channel of idOnlyChannels) {
    schemaOverrides[channel] = idSchema;
  }

  const optionalQueryChannels: DesktopRpcChannel[] = ["errorSources:getAll"];

  for (const channel of optionalQueryChannels) {
    schemaOverrides[channel] = optionalLooseObjectSchema;
  }

  const payloadSchemaByChannel = new Map<DesktopRpcChannel, z.ZodType>();

  for (const channel of DESKTOP_RPC_CHANNELS) {
    payloadSchemaByChannel.set(
      channel,
      schemaOverrides[channel] ?? optionalLooseObjectSchema,
    );
  }

  return (channel: DesktopRpcChannel, payload: unknown): unknown => {
    const schema = payloadSchemaByChannel.get(channel) ?? optionalLooseObjectSchema;
    return schema.parse(payload);
  };
}
