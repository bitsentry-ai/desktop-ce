import { z } from "zod";

export const desktopPluginFieldTypeSchema = z.enum([
  "string",
  "number",
  "boolean",
  "json",
  "string_array",
]);

export type DesktopPluginFieldType = z.infer<
  typeof desktopPluginFieldTypeSchema
>;

function isJsonSerializableValue(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonSerializableValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((item) =>
      isJsonSerializableValue(item),
    );
  }

  return false;
}

export const desktopPluginFieldDefinitionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  placeholder: z.string().min(1).optional(),
  type: desktopPluginFieldTypeSchema,
  required: z.boolean().default(false),
  secret: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  enumValues: z.array(z.string().min(1)).min(1).optional(),
}).superRefine((field, context) => {
  if (field.enumValues !== undefined && field.type !== "string") {
    context.addIssue({
      code: "custom",
      path: ["enumValues"],
      message: "enumValues are only supported for string fields.",
    });
  }

  if (field.defaultValue === undefined) {
    return;
  }

  let defaultValueIsValid = false;
  switch (field.type) {
    case "string":
      defaultValueIsValid = typeof field.defaultValue === "string";
      break;
    case "number":
      defaultValueIsValid =
        typeof field.defaultValue === "number" &&
        Number.isFinite(field.defaultValue);
      break;
    case "boolean":
      defaultValueIsValid = typeof field.defaultValue === "boolean";
      break;
    case "string_array":
      defaultValueIsValid =
        Array.isArray(field.defaultValue) &&
        field.defaultValue.every((item) => typeof item === "string");
      break;
    case "json":
      defaultValueIsValid = isJsonSerializableValue(field.defaultValue);
      break;
  }

  if (!defaultValueIsValid) {
    context.addIssue({
      code: "custom",
      path: ["defaultValue"],
      message: `defaultValue must match the "${field.type}" field type.`,
    });
  }

  if (
    field.type === "string" &&
    field.enumValues !== undefined &&
    typeof field.defaultValue === "string" &&
    !field.enumValues.includes(field.defaultValue)
  ) {
    context.addIssue({
      code: "custom",
      path: ["defaultValue"],
      message: "defaultValue must be one of the declared enumValues.",
    });
  }
});

export type DesktopPluginFieldDefinition = z.infer<
  typeof desktopPluginFieldDefinitionSchema
>;

export const desktopPluginActionRiskLevelSchema = z.enum(["read", "write"]);
export type DesktopPluginActionRiskLevel = z.infer<
  typeof desktopPluginActionRiskLevelSchema
>;

export const desktopPluginActionDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  riskLevel: desktopPluginActionRiskLevelSchema,
  fields: z.array(desktopPluginFieldDefinitionSchema),
  referencePath: z.string().min(1).optional(),
});

export type DesktopPluginActionDefinition = z.infer<
  typeof desktopPluginActionDefinitionSchema
>;

export const desktopPluginTriggerKindSchema = z.enum(["poll", "webhook"]);
export type DesktopPluginTriggerKind = z.infer<
  typeof desktopPluginTriggerKindSchema
>;

export const desktopPluginTriggerDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  kind: desktopPluginTriggerKindSchema,
  eventTypes: z.array(z.string().min(1)).default([]),
  fields: z.array(desktopPluginFieldDefinitionSchema).default([]),
  referencePath: z.string().min(1).optional(),
});

export type DesktopPluginTriggerDefinition = z.infer<
  typeof desktopPluginTriggerDefinitionSchema
>;

export const desktopPluginAuthSchema = z.object({
  fields: z.array(desktopPluginFieldDefinitionSchema),
});

export type DesktopPluginAuth = z.infer<typeof desktopPluginAuthSchema>;

export const desktopPluginErrorSourceTypeSchema = z.string().trim().min(1);

export type DesktopPluginErrorSourceType = z.infer<
  typeof desktopPluginErrorSourceTypeSchema
>;

export const desktopPluginErrorSourceSetupFieldTargetSchema = z.enum([
  "authToken",
  "organizationSlug",
  "organizationId",
  "projectSlugs",
  "projectIds",
  "baseUrl",
  "indexPatterns",
]);

export type DesktopPluginErrorSourceSetupFieldTarget = z.infer<
  typeof desktopPluginErrorSourceSetupFieldTargetSchema
>;

export const desktopPluginErrorSourceSetupFieldControlSchema = z.enum([
  "text",
  "password",
  "multiline_list",
]);

export type DesktopPluginErrorSourceSetupFieldControl = z.infer<
  typeof desktopPluginErrorSourceSetupFieldControlSchema
>;

export const desktopPluginErrorSourceSetupFieldStorageSchema = z.enum([
  "accessTokenRef",
  "configuration",
]);

export type DesktopPluginErrorSourceSetupFieldStorage = z.infer<
  typeof desktopPluginErrorSourceSetupFieldStorageSchema
>;

export const desktopPluginErrorSourceSetupFieldSchema = z
  .object({
    key: z.string().min(1),
    target: desktopPluginErrorSourceSetupFieldTargetSchema.optional(),
    storage: desktopPluginErrorSourceSetupFieldStorageSchema.default(
      "configuration",
    ),
    configurationKey: z.string().min(1).optional(),
    label: z.string().min(1),
    placeholder: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    required: z.boolean().default(false),
    control: desktopPluginErrorSourceSetupFieldControlSchema.default("text"),
  })
  .superRefine((field, context) => {
    if (
      field.storage === "accessTokenRef" &&
      field.configurationKey !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["configurationKey"],
        message:
          "configurationKey is only valid for configuration-backed setup fields.",
      });
    }
  });

export type DesktopPluginErrorSourceSetupField = z.infer<
  typeof desktopPluginErrorSourceSetupFieldSchema
>;

export const desktopPluginErrorSourceOauthSchema = z.object({
  envClientIdName: z.string().min(1).optional(),
  envClientSecretName: z.string().min(1).optional(),
  envRedirectUriName: z.string().min(1).optional(),
  defaultRedirectUri: z.string().min(1).optional(),
  scopes: z.array(z.string().min(1)).min(1).optional(),
  publicClient: z.boolean().optional(),
});

export type DesktopPluginErrorSourceOauth = z.infer<
  typeof desktopPluginErrorSourceOauthSchema
>;

export const desktopPluginDescriptorMetadataSchema = z.object({
  errorSource: z
    .object({
      sourceType: desktopPluginErrorSourceTypeSchema,
      setupFields: z.array(desktopPluginErrorSourceSetupFieldSchema).default([]),
      oauth: desktopPluginErrorSourceOauthSchema.optional(),
    })
    .optional(),
});

export type DesktopPluginDescriptorMetadata = z.infer<
  typeof desktopPluginDescriptorMetadataSchema
>;

export const desktopPluginDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  referenceRepositoryPath: z.string().min(1).optional(),
  metadata: desktopPluginDescriptorMetadataSchema.optional(),
  auth: desktopPluginAuthSchema,
  actions: z.array(desktopPluginActionDefinitionSchema),
  triggers: z.array(desktopPluginTriggerDefinitionSchema),
});

export type DesktopPluginDescriptor = z.infer<typeof desktopPluginDescriptorSchema>;

export const desktopPluginInstallFromArchiveRequestSchema = z.object({
  archiveBase64: z.string().min(1),
  installRoot: z.string().min(1).optional(),
});

export type DesktopPluginInstallFromArchiveRequest = z.infer<
  typeof desktopPluginInstallFromArchiveRequestSchema
>;

export const desktopPluginInstallFromArchiveResultSchema = z.object({
  pluginId: z.string().min(1),
  installedPath: z.string().min(1),
  extractedEntryPath: z.string().min(1),
  descriptor: desktopPluginDescriptorSchema,
});

export type DesktopPluginInstallFromArchiveResult = z.infer<
  typeof desktopPluginInstallFromArchiveResultSchema
>;

export const desktopPluginExecutionRequestSchema = z.object({
  pluginId: z.string().min(1),
  actionId: z.string().min(1),
  auth: z.record(z.string(), z.unknown()).optional().default({}),
  input: z.record(z.string(), z.unknown()).optional().default({}),
});

export type DesktopPluginExecutionRequest = z.infer<
  typeof desktopPluginExecutionRequestSchema
>;

export const desktopPluginExecutionResultSchema = z.object({
  pluginId: z.string().min(1),
  actionId: z.string().min(1),
  ok: z.boolean(),
  status: z.number().int().nonnegative(),
  summary: z.string().min(1),
  data: z.unknown().optional(),
});

export type DesktopPluginExecutionResult = z.infer<
  typeof desktopPluginExecutionResultSchema
>;

export type DesktopPluginInstallResult = {
  pluginId: string;
  installedPath: string;
  extractedEntryPath: string;
};

export type DesktopPluginCodeActionContext = {
  pluginId: string;
  actionId: string;
  auth: Record<string, unknown>;
  input: Record<string, unknown>;
  host: {
    pluginRoot: string;
    entryPath: string;
    localPluginDirectories: string[];
    installPluginFromArchive(input: {
      archive: Uint8Array;
      installRoot?: string;
    }): Promise<DesktopPluginInstallResult>;
    reloadPlugins(): Promise<void>;
  };
};

export type DesktopPluginCodeActionHandlerResult = {
  ok?: boolean;
  status: number;
  summary: string;
  data?: unknown;
};

export type DesktopPluginCodeActionHandler = (
  context: DesktopPluginCodeActionContext,
) =>
  | DesktopPluginCodeActionHandlerResult
  | Promise<DesktopPluginCodeActionHandlerResult>;

export const desktopCodePluginActionSchema = desktopPluginActionDefinitionSchema.extend({
  execute: z.custom<DesktopPluginCodeActionHandler>(
    (value) => typeof value === "function",
    "execute must be a function.",
  ),
});

export type DesktopCodePluginAction = z.infer<typeof desktopCodePluginActionSchema>;

export const desktopCodePluginSchema = desktopPluginDescriptorSchema
  .omit({
    actions: true,
    triggers: true,
  })
  .extend({
    actions: z.array(desktopCodePluginActionSchema),
    triggers: z.array(desktopPluginTriggerDefinitionSchema).default([]),
  });

export type DesktopCodePlugin = z.infer<typeof desktopCodePluginSchema>;
