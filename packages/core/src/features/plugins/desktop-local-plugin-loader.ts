import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  desktopPluginActionDefinitionSchema,
  desktopPluginAuthSchema,
  desktopPluginManifestMetadataSchema,
  desktopPluginTriggerDefinitionSchema,
} from "./plugins.types";

const desktopLocalHttpPluginPaginationSchema = z.object({
  kind: z.literal("next_url"),
  itemsPath: z.string().min(1),
  nextPath: z.string().min(1),
  maxPages: z.number().int().positive().max(50).optional(),
});

const desktopLocalHttpPluginJoinTemplateSchema = z.object({
  kind: z.literal("join"),
  values: z.array(z.string().min(1)).min(1),
  separator: z.string().default(" "),
});

const desktopLocalHttpPluginTemplateValueSchema = z.union([
  z.string().min(1),
  desktopLocalHttpPluginJoinTemplateSchema,
]);

const desktopLocalHttpPluginResponsePaginationSchema = z.object({
  kind: z.literal("link_header_cursor"),
  header: z.string().min(1).optional(),
  relation: z.string().min(1).optional(),
  cursorQueryParam: z.string().min(1).optional(),
  hasMoreParam: z.string().min(1).optional(),
  truthyValue: z.string().min(1).optional(),
});

const desktopLocalHttpPluginResponseSchema = z.object({
  itemsKey: z.string().min(1),
  itemsPath: z.string().min(1).optional(),
  nextCursorKey: z.string().min(1).optional(),
  hasMoreKey: z.string().min(1).optional(),
  pagination: desktopLocalHttpPluginResponsePaginationSchema.optional(),
});

const desktopLocalHttpPluginTransportSchema = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), desktopLocalHttpPluginTemplateValueSchema).optional(),
  body: z.unknown().optional(),
  successStatusCodes: z.array(z.number().int().nonnegative()).optional(),
  pagination: desktopLocalHttpPluginPaginationSchema.optional(),
  response: desktopLocalHttpPluginResponseSchema.optional(),
});

const desktopLocalBuiltinPluginTransportSchema = z.object({
  kind: z.literal("builtin"),
});

const desktopLocalPluginActionSchema = desktopPluginActionDefinitionSchema.extend({
  transport: z.union([
    desktopLocalHttpPluginTransportSchema,
    desktopLocalBuiltinPluginTransportSchema,
  ]),
});

const desktopLocalPluginFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  referenceRepositoryPath: z.string().min(1).optional(),
  metadata: desktopPluginManifestMetadataSchema.optional(),
  auth: desktopPluginAuthSchema,
  actions: z.array(desktopLocalPluginActionSchema),
  triggers: z.array(desktopPluginTriggerDefinitionSchema).default([]),
});

export type DesktopLocalPluginFile = z.infer<typeof desktopLocalPluginFileSchema>;
export type DesktopLocalPluginAction = DesktopLocalPluginFile["actions"][number];

export type LoadedDesktopLocalPlugin = {
  definition: DesktopLocalPluginFile;
  manifestPath: string;
  referenceRepositoryPath: string;
};

function readPluginManifest(pathname: string): LoadedDesktopLocalPlugin | null {
  const raw = fs.readFileSync(pathname, "utf8");
  const parsed = desktopLocalPluginFileSchema.parse(JSON.parse(raw) as unknown);
  const manifestDirectory = path.dirname(pathname);
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
  const relativeManifestDirectory = path.relative(workspaceRoot, manifestDirectory);
  return {
    definition: parsed,
    manifestPath: pathname,
    referenceRepositoryPath:
      parsed.referenceRepositoryPath ??
      (relativeManifestDirectory.startsWith("..")
        ? manifestDirectory
        : relativeManifestDirectory),
  };
}

function collectPluginManifestPaths(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const manifests: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const manifestPath = path.join(directory, entry.name, "plugin.json");
      if (fs.existsSync(manifestPath)) {
        manifests.push(manifestPath);
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".plugin.json")) {
      manifests.push(path.join(directory, entry.name));
    }
  }

  manifests.sort((left, right) => left.localeCompare(right));
  return manifests;
}

export function loadDesktopLocalPlugins(
  directories: string[],
): LoadedDesktopLocalPlugin[] {
  const loaded: LoadedDesktopLocalPlugin[] = [];

  for (const directory of directories) {
    for (const manifestPath of collectPluginManifestPaths(directory)) {
      try {
        const plugin = readPluginManifest(manifestPath);
        if (plugin !== null) {
          loaded.push(plugin);
        }
      } catch (error) {
        console.warn(
          `[desktop-plugin-loader] Skipping invalid plugin manifest at ${manifestPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return loaded;
}
