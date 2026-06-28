import { z, type ZodType } from "zod";

import type {
  DesktopCodePlugin,
  DesktopCodePluginAction,
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
  DesktopPluginDescriptor,
} from "./plugins.types";
import {
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
};

type LoadedPluginRuntimeContext = {
  loadedPlugin: LoadedDesktopCodePlugin;
  localPluginDirectories: string[];
  installPluginFromArchive(input: {
    archive: Uint8Array;
    installRoot?: string;
  }): Promise<{
    pluginId: string;
    installedPath: string;
    extractedEntryPath: string;
  }>;
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
        host: {
          pluginRoot: context.loadedPlugin.pluginRoot,
          entryPath: context.loadedPlugin.entryPath,
          localPluginDirectories: context.localPluginDirectories,
          installPluginFromArchive: (archiveInput) =>
            context.installPluginFromArchive(archiveInput),
          reloadPlugins: () => context.reloadPlugins(),
        },
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
    triggers: plugin.triggers ?? [],
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
  };
}

export class DesktopPluginRegistry {
  private readonly plugins = new Map<string, PluginRuntime>();

  constructor(
    localPlugins: LoadedDesktopCodePlugin[] = [],
    context: Omit<LoadedPluginRuntimeContext, "loadedPlugin"> = {
      localPluginDirectories: [],
      installPluginFromArchive() {
        return Promise.reject(
          new Error("Plugin installation is not available in this runtime."),
        );
      },
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
}

export class DesktopPluginRuntimeService {
  constructor(protected registry = new DesktopPluginRegistry()) {}

  listPlugins(): DesktopPluginDescriptor[] {
    return this.registry.list();
  }

  getPlugin(pluginId: string): DesktopPluginDescriptor | null {
    return this.registry.get(pluginId);
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
