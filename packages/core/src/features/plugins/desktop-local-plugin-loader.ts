import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import * as pluginSdk from "@bitsentry/plugin-sdk";

const localRequire = createRequire(__filename);

export type LoadedDesktopCodePlugin = {
  plugin: pluginSdk.DesktopCodePlugin;
  entryPath: string;
  pluginRoot: string;
  referenceRepositoryPath: string;
};

function resolveWorkspaceRoot(): string {
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

  return workspaceRoot;
}

function readPluginExport(moduleExports: unknown): unknown {
  if (
    moduleExports !== null &&
    typeof moduleExports === "object" &&
    "default" in moduleExports
  ) {
    const defaultExport = (moduleExports as { default?: unknown }).default;
    if (defaultExport !== undefined) {
      return defaultExport;
    }
  }

  if (
    moduleExports !== null &&
    typeof moduleExports === "object" &&
    "plugin" in moduleExports
  ) {
    const namedExport = (moduleExports as { plugin?: unknown }).plugin;
    if (namedExport !== undefined) {
      return namedExport;
    }
  }

  return moduleExports;
}

function collectPluginEntryPaths(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const pluginEntries: string[] = [];

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      const candidateEntryPaths = [
        path.join(directory, entry.name, "plugin.js"),
        path.join(directory, entry.name, "dist", "plugin.js"),
      ];
      for (const pluginEntryPath of candidateEntryPaths) {
        if (fs.existsSync(pluginEntryPath)) {
          pluginEntries.push(pluginEntryPath);
          break;
        }
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".plugin.js")) {
      pluginEntries.push(path.join(directory, entry.name));
    }
  }

  pluginEntries.sort((left, right) => left.localeCompare(right));
  return pluginEntries;
}

function loadPluginEntry(entryPath: string): LoadedDesktopCodePlugin {
  const pluginRoot = path.dirname(entryPath);
  const workspaceRoot = resolveWorkspaceRoot();
  const relativePluginRoot = path.relative(workspaceRoot, pluginRoot);

  Reflect.deleteProperty(localRequire.cache, localRequire.resolve(entryPath));
  const moduleExports = localRequire(entryPath) as unknown;
  const plugin = pluginSdk.desktopCodePluginSchema.parse(
    readPluginExport(moduleExports),
  );
  let referenceRepositoryPath = relativePluginRoot;
  if (plugin.referenceRepositoryPath !== undefined) {
    referenceRepositoryPath = plugin.referenceRepositoryPath;
  } else if (relativePluginRoot.startsWith("..")) {
    referenceRepositoryPath = pluginRoot;
  }

  return {
    plugin,
    entryPath,
    pluginRoot,
    referenceRepositoryPath,
  };
}

export function loadDesktopLocalPlugins(
  directories: string[],
): LoadedDesktopCodePlugin[] {
  const loaded: LoadedDesktopCodePlugin[] = [];

  for (const directory of directories) {
    for (const entryPath of collectPluginEntryPaths(directory)) {
      try {
        loaded.push(loadPluginEntry(entryPath));
      } catch (error) {
        let message = String(error);
        if (error instanceof Error) {
          message = error.message;
        }
        console.warn(
          `[desktop-plugin-loader] Skipping invalid code plugin at ${entryPath}: ${message}`,
        );
      }
    }
  }

  return loaded;
}
