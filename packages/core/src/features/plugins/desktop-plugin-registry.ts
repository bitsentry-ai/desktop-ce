import { z, type ZodType } from "zod";

import type {
  DesktopCodePlugin,
  DesktopCodePluginAction,
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
  DesktopPluginDescriptor,
  DesktopPluginPersistedDataSourceSetup,
  DesktopPluginDataSourceRecord,
  DesktopCodePluginDataSource,
  DesktopPluginInstallFromArtifactRequest,
  DesktopPluginInstallFromArtifactResult,
  DesktopPluginCodeHostContext,
} from "./plugins.types";
import {
  desktopPluginPersistedDataSourceSetupSchema,
  desktopPluginDataSourceRecordSchema,
  desktopPluginExecutionRequestSchema,
  desktopPluginExecutionResultSchema,
  desktopPluginDescriptorSchema,
} from "./plugins.types";
import type { LoadedDesktopCodePlugin } from "./desktop-local-plugin-loader";

type PluginActionRuntime = {
  id: string;
  title: string;
  description: string;
  riskLevel: "read" | "write";
  fields: DesktopPluginFieldDefinition[];
  referencePath?: string;
  inputSchema: ZodType<Record<string, unknown>>;
  execute(input: {
    auth: Record<string, unknown>;
    input: Record<string, unknown>;
  }): Promise<DesktopPluginExecutionResult>;
};

type PluginRuntime = {
  descriptor: DesktopPluginDescriptor;
  actions: Map<string, PluginActionRuntime>;
  dataSource?: DesktopCodePluginDataSource;
  host: DesktopPluginCodeHostContext;
};

type LoadedPluginRuntimeContext = {
  loadedPlugin: LoadedDesktopCodePlugin;
  localPluginDirectories: string[];
  reloadPlugins(): Promise<void>;
};

export function buildPluginInputSchema(
  fields: DesktopPluginFieldDefinition[],
): ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};

  for (const field of fields) {
    let schema: z.ZodType;
    switch (field.type) {
      case "number":
        schema = z.number();
        break;
      case "boolean":
        schema = z.boolean();
        break;
      case "json":
        schema = z.unknown();
        break;
      case "string_array":
        schema = z.array(z.string());
        break;
      case "string":
      default:
        schema = z.string();
        break;
    }

    if (field.type === "string" && field.enumValues !== undefined) {
      schema = schema.refine(
        (value) =>
          typeof value === "string" && field.enumValues?.includes(value) === true,
        {
          message: `${field.label} must be one of: ${field.enumValues.join(", ")}.`,
        },
      );
    }

    if (field.defaultValue !== undefined) {
      schema = schema.default(field.defaultValue);
    } else if (!field.required) {
      schema = schema.optional();
    }

    shape[field.key] = schema;
  }

  return z.looseObject(shape);
}

function createPluginHostContext(
  context: LoadedPluginRuntimeContext,
): DesktopPluginCodeHostContext {
  return {
    pluginRoot: context.loadedPlugin.pluginRoot,
    entryPath: context.loadedPlugin.entryPath,
    localPluginDirectories: context.localPluginDirectories,
    reloadPlugins: () => context.reloadPlugins(),
  };
}

function createActionRuntime(
  pluginId: string,
  action: DesktopCodePluginAction,
  context: LoadedPluginRuntimeContext,
): PluginActionRuntime {
  const inputSchema = buildPluginInputSchema(action.fields);

  return {
    id: action.id,
    title: action.title,
    description: action.description,
    riskLevel: action.riskLevel,
    fields: action.fields,
    referencePath: action.referencePath,
    inputSchema,
    async execute(request) {
      const validatedInput = inputSchema.parse(request.input);
      const result = await action.execute({
        pluginId,
        actionId: action.id,
        auth: request.auth,
        input: validatedInput,
        host: createPluginHostContext(context),
      });

      return desktopPluginExecutionResultSchema.parse({
        pluginId,
        actionId: action.id,
        ok: result.ok ?? true,
        status: result.status,
        summary: result.summary,
        data: result.data,
      });
    },
  };
}

function createPluginRuntime(
  loadedPlugin: LoadedDesktopCodePlugin,
  context: Omit<LoadedPluginRuntimeContext, "loadedPlugin">,
): PluginRuntime {
  const plugin: DesktopCodePlugin = {
    ...loadedPlugin.plugin,
    referenceRepositoryPath: loadedPlugin.referenceRepositoryPath,
  };
  const descriptor = desktopPluginDescriptorSchema.parse({
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    referenceRepositoryPath: plugin.referenceRepositoryPath,
    metadata: plugin.metadata,
    auth: plugin.auth,
    actions: plugin.actions.map(
      ({ execute: _execute, ...action }) => action,
    ),
  });
  const runtimeContext = {
    ...context,
    loadedPlugin: {
      ...loadedPlugin,
      plugin,
    },
  };
  const actions = plugin.actions.map((action) =>
    createActionRuntime(plugin.id, action, runtimeContext),
  );

  return {
    descriptor,
    actions: new Map(actions.map((action) => [action.id, action])),
    dataSource: plugin.dataSource,
    host: createPluginHostContext(runtimeContext),
  };
}

function normalizeOptionalRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function defaultResolveErrorSourceSetup(
  setupValues: Record<string, unknown>,
): DesktopPluginPersistedDataSourceSetup {
  return {
    configuration: { ...setupValues },
  };
}

function defaultBuildErrorSourceAuth(
  source: DesktopPluginDataSourceRecord,
): Record<string, unknown> {
  const auth: Record<string, unknown> = {
    ...normalizeOptionalRecord(source.configuration),
  };
  const accessToken = source.accessTokenRef?.trim();
  if (accessToken !== undefined && accessToken.length > 0) {
    auth.accessToken = accessToken;
  }
  const refreshToken = source.refreshTokenRef?.trim();
  if (refreshToken !== undefined && refreshToken.length > 0) {
    auth.refreshToken = refreshToken;
  }
  if (source.expiresAt !== null && source.expiresAt !== undefined) {
    auth.expiresAt = source.expiresAt;
  }
  if (source.grantedScopes !== undefined && source.grantedScopes.length > 0) {
    auth.grantedScopes = source.grantedScopes;
  }

  return auth;
}

function defaultBuildErrorSourceProbeAuth(
  persistedSetup: DesktopPluginPersistedDataSourceSetup,
): Record<string, unknown> {
  return defaultBuildErrorSourceAuth({
    sourceType: "plugin",
    accessTokenRef: persistedSetup.accessTokenRef,
    refreshTokenRef: persistedSetup.refreshTokenRef,
    expiresAt: persistedSetup.expiresAt,
    grantedScopes: persistedSetup.grantedScopes,
    configuration: persistedSetup.configuration,
  });
}

export class DesktopPluginRegistry {
  private readonly plugins = new Map<string, PluginRuntime>();

  constructor(
    localPlugins: LoadedDesktopCodePlugin[] = [],
    context: Omit<LoadedPluginRuntimeContext, "loadedPlugin"> = {
      localPluginDirectories: [],
      reloadPlugins() {
        return Promise.resolve();
      },
    },
  ) {
    for (const plugin of localPlugins) {
      this.register(createPluginRuntime(plugin, context));
    }
  }

  register(plugin: PluginRuntime): void {
    this.plugins.set(plugin.descriptor.id, plugin);
  }

  list(): DesktopPluginDescriptor[] {
    return Array.from(this.plugins.values(), (plugin) => plugin.descriptor);
  }

  get(pluginId: string): DesktopPluginDescriptor | null {
    return this.plugins.get(pluginId)?.descriptor ?? null;
  }

  getAction(pluginId: string, actionId: string): PluginActionRuntime | null {
    return this.plugins.get(pluginId)?.actions.get(actionId) ?? null;
  }

  getErrorSource(pluginId: string): DesktopCodePluginDataSource | null {
    return this.plugins.get(pluginId)?.dataSource ?? null;
  }

  getPluginHost(pluginId: string): DesktopPluginCodeHostContext | null {
    return this.plugins.get(pluginId)?.host ?? null;
  }
}

export class DesktopPluginRuntimeService {
  constructor(protected registry = new DesktopPluginRegistry()) {}

  listPlugins(): DesktopPluginDescriptor[] {
    return this.registry.list();
  }

  getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.registry.get(pluginId);
  }

  async resolveErrorSourceSetup(input: {
    pluginId: string;
    setupValues: Record<string, unknown>;
  }): Promise<DesktopPluginPersistedDataSourceSetup> {
    const errorSource = this.registry.getErrorSource(input.pluginId);
    let resolved: DesktopPluginPersistedDataSourceSetup;
    if (errorSource?.resolveSetup === undefined) {
      resolved = defaultResolveErrorSourceSetup(input.setupValues);
    } else {
      const host = this.registry.getPluginHost(input.pluginId);
      if (host === null) {
        throw new Error(`Unknown plugin: ${input.pluginId}`);
      }
      resolved = await errorSource.resolveSetup({
        pluginId: input.pluginId,
        setupValues: input.setupValues,
        host,
      });
    }

    return desktopPluginPersistedDataSourceSetupSchema.parse(resolved);
  }

  async buildErrorSourceAuth(input: {
    pluginId: string;
    source: DesktopPluginDataSourceRecord;
  }): Promise<Record<string, unknown>> {
    const source = desktopPluginDataSourceRecordSchema.parse(input.source);
    const errorSource = this.registry.getErrorSource(input.pluginId);
    if (errorSource?.buildAuth === undefined) {
      return defaultBuildErrorSourceAuth(source);
    }

    const host = this.registry.getPluginHost(input.pluginId);
    if (host === null) {
      throw new Error(`Unknown plugin: ${input.pluginId}`);
    }

    return errorSource.buildAuth({
      pluginId: input.pluginId,
      source,
      host,
    });
  }

  async buildErrorSourceProbeAuth(input: {
    pluginId: string;
    persistedSetup: DesktopPluginPersistedDataSourceSetup;
  }): Promise<Record<string, unknown>> {
    const persistedSetup = desktopPluginPersistedDataSourceSetupSchema.parse(
      input.persistedSetup,
    );
    const errorSource = this.registry.getErrorSource(input.pluginId);
    if (errorSource?.buildProbeAuth === undefined) {
      return defaultBuildErrorSourceProbeAuth(persistedSetup);
    }

    const host = this.registry.getPluginHost(input.pluginId);
    if (host === null) {
      throw new Error(`Unknown plugin: ${input.pluginId}`);
    }

    return errorSource.buildProbeAuth({
      pluginId: input.pluginId,
      persistedSetup,
      host,
    });
  }

  getErrorSourceProbeProjectIdentity(pluginId: string): "id" | "slug" {
    return this.registry.getErrorSource(pluginId)?.probeProjectIdentity ?? "id";
  }

  installFromArtifact(
    request: DesktopPluginInstallFromArtifactRequest,
  ): Promise<DesktopPluginInstallFromArtifactResult> {
    void request;
    return Promise.reject(
      new Error("Plugin installation is not available in this runtime."),
    );
  }

  async executeAction(
    input: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    const request = desktopPluginExecutionRequestSchema.parse(input);
    const plugin = this.registry.get(request.pluginId);
    if (plugin === null) {
      throw new Error(`Unknown plugin: ${request.pluginId}`);
    }

    const action = this.registry.getAction(request.pluginId, request.actionId);
    if (action === null) {
      throw new Error(
        `Unknown action "${request.actionId}" for plugin "${request.pluginId}"`,
      );
    }

    for (const field of plugin.auth.fields) {
      if (!field.required) continue;
      const value = request.auth[field.key];
      let normalizedValue = "";
      if (typeof value === "string") {
        normalizedValue = value.trim();
      } else if (value !== undefined && value !== null) {
        normalizedValue = JSON.stringify(value);
      }
      if (normalizedValue.length === 0) {
        throw new Error(`Missing required auth field: ${field.key}`);
      }
    }

    return action.execute({
      auth: request.auth,
      input: request.input,
    });
  }
}
