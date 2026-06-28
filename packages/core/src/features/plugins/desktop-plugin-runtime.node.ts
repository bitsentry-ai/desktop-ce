import fs from "node:fs";
import { cp, mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
  DesktopPluginInstallResult,
} from "./plugins.types";
import { desktopCodePluginSchema } from "./plugins.types";
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

async function collectPluginEntryPaths(rootDirectory: string): Promise<string[]> {
  const matches: string[] = [];
  const pending = [rootDirectory];

  while (pending.length > 0) {
    const currentDirectory = pending.pop();
    if (currentDirectory === undefined) {
      continue;
    }

    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }

      const nextPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        pending.push(nextPath);
        continue;
      }

      if (entry.isFile() && entry.name === "plugin.js") {
        matches.push(nextPath);
      }
    }
  }

  matches.sort((left, right) => {
    const depthDifference =
      left.split(path.sep).length - right.split(path.sep).length;
    if (depthDifference !== 0) {
      return depthDifference;
    }

    return left.localeCompare(right);
  });
  return matches;
}

async function installPluginFromArchive(input: {
  archive: Buffer;
  installRoot: string;
}): Promise<DesktopPluginInstallResult> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "bitsentry-plugin-deploy-"));

  try {
    const tar = (await import(localRequire.resolve("tar"))) as {
      x(options: { file: string; cwd: string }): Promise<void>;
    };
    const archivePath = path.join(tempRoot, "plugin.tar.gz");
    const extractDirectory = path.join(tempRoot, "extract");
    await mkdir(extractDirectory, { recursive: true });
    await fs.promises.writeFile(archivePath, input.archive);
    await tar.x({
      file: archivePath,
      cwd: extractDirectory,
    });

    const entryPaths = await collectPluginEntryPaths(extractDirectory);
    const entryPath = entryPaths[0];
    if (entryPath === undefined) {
      throw new Error(
        "Downloaded plugin archive does not contain a plugin.js code entrypoint.",
      );
    }

    const pluginRoot = path.dirname(entryPath);
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

    const installedPath = path.join(input.installRoot, pluginId);
    await mkdir(input.installRoot, { recursive: true });
    await rm(installedPath, { recursive: true, force: true });
    await cp(pluginRoot, installedPath, { recursive: true });

    return {
      pluginId,
      installedPath,
      extractedEntryPath: path.relative(extractDirectory, entryPath),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function resolveRepoManagedPluginDirectory(workspaceRoot: string): string {
  const monorepoDesktopCePackagesDirectory = path.join(
    workspaceRoot,
    "apps",
    "desktop-ce",
    "packages",
  );
  if (fs.existsSync(monorepoDesktopCePackagesDirectory)) {
    return path.join(monorepoDesktopCePackagesDirectory, "plugins");
  }

  return path.join(workspaceRoot, "packages", "plugins");
}

function resolveBundledPluginDirectory(): string {
  return path.resolve(__dirname, "..", "..", "..", "..", "plugins");
}

function defaultLocalPluginDirectories(): string[] {
  const configured = process.env.BITSENTRY_PLUGIN_DIR;
  const bundledDirectory = resolveBundledPluginDirectory();
  if (typeof configured === "string" && configured.trim().length > 0) {
    return Array.from(
      new Set([
        ...configured
          .split(path.delimiter)
          .map((directory) => directory.trim())
          .filter((directory) => directory.length > 0),
        bundledDirectory,
      ]),
    );
  }

  let workspaceRoot = process.cwd();
  let currentDirectory = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(currentDirectory, "pnpm-workspace.yaml"))) {
      workspaceRoot = currentDirectory;
      break;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return Array.from(
    new Set([
      resolveRepoManagedPluginDirectory(workspaceRoot),
      bundledDirectory,
      path.join(workspaceRoot, ".bitsentry", "plugins"),
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

  private reloadRegistry(): void {
    this.registry = new DesktopPluginRegistry(
      loadDesktopLocalPlugins(this.localPluginDirectories),
      {
        localPluginDirectories: this.localPluginDirectories,
        installPluginFromArchive: ({ archive, installRoot }) => {
          let resolvedInstallRoot = installRoot;
          if (resolvedInstallRoot === undefined) {
            resolvedInstallRoot = this.localPluginDirectories[0];
          }
          if (resolvedInstallRoot === undefined) {
            resolvedInstallRoot = path.join(process.cwd(), ".bitsentry", "plugins");
          }

          return installPluginFromArchive({
            archive: Buffer.from(archive),
            installRoot: resolvedInstallRoot,
          });
        },
        reloadPlugins: () => {
          this.reloadRegistry();
          return Promise.resolve();
        },
      },
    );
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
