import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
  DesktopPluginInstallFromArtifactRequest,
  DesktopPluginInstallFromArtifactResult,
  DesktopPluginInstallResult,
} from "./plugins.types";
import {
  desktopCodePluginSchema,
  desktopPluginInstallFromArtifactRequestSchema,
  desktopPluginInstallFromArtifactResultSchema,
} from "./plugins.types";
import {
  NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
  type DesktopPluginStoredAuthRecord,
  type DesktopPluginStoredAuthStore,
} from "./desktop-plugin-auth-store";
import { loadDesktopLocalPlugins } from "./desktop-local-plugin-loader";
import {
  DesktopPluginRegistry,
  DesktopPluginRuntimeService,
} from "./desktop-plugin-registry";

const localRequire = createRequire(__filename);

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return undefined;
}

function resolvePluginInstallPath(
  installRoot: string,
  pluginId: string,
): string {
  const resolvedInstallRoot = path.resolve(installRoot);
  const installedPath = path.resolve(resolvedInstallRoot, pluginId);
  const relativePath = path.relative(resolvedInstallRoot, installedPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`Invalid code plugin id: "${pluginId}".`);
  }

  return installedPath;
}

async function installPluginFromArtifact(input: {
  artifact: Buffer;
  installRoot: string;
}): Promise<DesktopPluginInstallResult> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "bitsentry-plugin-file-"));

  try {
    const entryPath = path.join(tempRoot, "plugin.js");
    await writeFile(entryPath, input.artifact);

    const modulePath = localRequire.resolve(entryPath);
    Reflect.deleteProperty(localRequire.cache, modulePath);
    const moduleExports = localRequire(modulePath) as unknown;
    let rawPlugin = moduleExports;
    if (
      moduleExports !== null &&
      typeof moduleExports === "object" &&
      "plugin" in moduleExports
    ) {
      rawPlugin = (moduleExports as { plugin?: unknown }).plugin;
    } else if (
      moduleExports !== null &&
      typeof moduleExports === "object" &&
      "default" in moduleExports
    ) {
      rawPlugin = (moduleExports as { default?: unknown }).default;
    }

    const parsedPlugin = desktopCodePluginSchema.parse(rawPlugin);
    const pluginId = readTrimmedString(parsedPlugin.id);
    if (pluginId === undefined) {
      throw new Error("Downloaded code plugin is missing a valid id.");
    }

    const installedPath = resolvePluginInstallPath(input.installRoot, pluginId);
    await rm(installedPath, { recursive: true, force: true });
    await mkdir(installedPath, { recursive: true });
    await writeFile(path.join(installedPath, "plugin.js"), input.artifact);

    return {
      pluginId,
      installedPath,
      extractedEntryPath: "plugin.js",
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function defaultLocalPluginDirectories(): string[] {
  const configured = process.env.BITSENTRY_PLUGIN_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return Array.from(
      new Set(
        configured
          .split(path.delimiter)
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0),
      ),
    );
  }

  return Array.from(
    new Set([
      path.join(process.cwd(), ".bitsentry", "plugins"),
    ]),
  );
}

export function resolveDesktopPluginDirectories(
  additionalDirectories: string[] = [],
): string[] {
  return Array.from(
    new Set([
      ...defaultLocalPluginDirectories(),
      ...additionalDirectories
        .map((directory) => directory.trim())
        .filter((directory) => directory.length > 0),
    ]),
  );
}

function parseStoredFieldValue(
  field: DesktopPluginFieldDefinition,
  rawValue: unknown,
): unknown {
  let normalized: string | undefined;
  if (typeof rawValue === "string") {
    normalized = rawValue.trim();
  }

  if (field.type === "boolean") {
    if (typeof rawValue === "boolean") {
      return rawValue;
    }

    if (normalized !== "true" && normalized !== "false") {
      throw new Error(
        `Stored auth field "${field.key}" for plugin auth must be true or false.`,
      );
    }

    return normalized === "true";
  }

  if (field.type === "number") {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      return rawValue;
    }

    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      throw new Error(
        `Stored auth field "${field.key}" for plugin auth must be a number.`,
      );
    }
    return numeric;
  }

  if (field.type === "json") {
    if (typeof rawValue !== "string") {
      return rawValue;
    }

    return JSON.parse(rawValue);
  }

  if (field.type === "string_array") {
    if (Array.isArray(rawValue)) {
      return rawValue
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }

    if (typeof rawValue !== "string") {
      throw new Error(
        `Stored auth field "${field.key}" for plugin auth must be a string array.`,
      );
    }

    return rawValue
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  if (typeof rawValue !== "string") {
    throw new Error(
      `Stored auth field "${field.key}" for plugin auth must be a string.`,
    );
  }

  if (
    field.enumValues !== undefined &&
    !field.enumValues.includes(rawValue)
  ) {
    throw new Error(
      `Stored auth field "${field.key}" for plugin auth must be one of: ${field.enumValues.join(", ")}.`,
    );
  }

  return rawValue;
}

function resolveStoredAuth(
  fields: DesktopPluginFieldDefinition[],
  storedValues: DesktopPluginStoredAuthRecord,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const field of fields) {
    const rawValue = storedValues[field.key];
    if (rawValue === undefined) {
      continue;
    }

    if (typeof rawValue === "string" && rawValue.trim().length === 0) {
      continue;
    }

    resolved[field.key] = parseStoredFieldValue(field, rawValue);
  }

  return resolved;
}

function applyFieldDefaults(
  fields: DesktopPluginFieldDefinition[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const resolved = {
    ...values,
  };

  for (const field of fields) {
    if (resolved[field.key] !== undefined || field.defaultValue === undefined) {
      continue;
    }

    resolved[field.key] = field.defaultValue;
  }

  return resolved;
}

class DesktopNodePluginRuntimeService extends DesktopPluginRuntimeService {
  constructor(
    private readonly storedAuthStore: DesktopPluginStoredAuthStore,
    private readonly localPluginDirectories: string[],
  ) {
    super(new DesktopPluginRegistry());
    this.reloadRegistry();
  }

  private resolveInstallRoot(installRoot: string | undefined): string {
    if (installRoot !== undefined) {
      return installRoot;
    }

    const localPluginDirectory = this.localPluginDirectories[0];
    if (localPluginDirectory !== undefined) {
      return localPluginDirectory;
    }

    return path.join(process.cwd(), ".bitsentry", "plugins");
  }

  private installArtifactBytes(input: {
    artifact: Uint8Array;
    installRoot?: string;
  }): Promise<DesktopPluginInstallResult> {
    return installPluginFromArtifact({
      artifact: Buffer.from(input.artifact),
      installRoot: this.resolveInstallRoot(input.installRoot),
    });
  }

  private reloadRegistry(): void {
    this.registry = new DesktopPluginRegistry(
      loadDesktopLocalPlugins(this.localPluginDirectories),
      {
        localPluginDirectories: this.localPluginDirectories,
        reloadPlugins: () => {
          this.reloadRegistry();
          return Promise.resolve();
        },
      },
    );
  }

  override async installFromArtifact(
    input: DesktopPluginInstallFromArtifactRequest,
  ): Promise<DesktopPluginInstallFromArtifactResult> {
    const request = desktopPluginInstallFromArtifactRequestSchema.parse(input);
    const artifact = Buffer.from(request.artifactBase64, "base64");
    if (artifact.length === 0) {
      throw new Error("Plugin artifact payload is empty.");
    }

    const installResult = await this.installArtifactBytes({
      artifact,
      installRoot: request.installRoot,
    });
    this.reloadRegistry();

    const descriptor = this.getPlugin(installResult.pluginId);
    if (descriptor === null) {
      throw new Error(
        `Installed plugin "${installResult.pluginId}" could not be loaded.`,
      );
    }

    return desktopPluginInstallFromArtifactResultSchema.parse({
      ...installResult,
      descriptor,
    });
  }

  override async executeAction(
    request: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    const plugin = this.getPlugin(request.pluginId);
    let auth = request.auth ?? {};

    if (plugin !== null) {
      const storedValues = await this.storedAuthStore.get(request.pluginId);
      const storedAuth = resolveStoredAuth(plugin.auth.fields, storedValues);
      auth = applyFieldDefaults(plugin.auth.fields, {
        ...storedAuth,
        ...auth,
      });
    }

    return super.executeAction({
      ...request,
      auth,
    });
  }
}

export function createDesktopNodePluginRuntimeService(
  localPluginDirectories = defaultLocalPluginDirectories(),
  storedAuthStore: DesktopPluginStoredAuthStore = NOOP_DESKTOP_PLUGIN_STORED_AUTH_STORE,
): DesktopPluginRuntimeService {
  return new DesktopNodePluginRuntimeService(
    storedAuthStore,
    localPluginDirectories,
  );
}
