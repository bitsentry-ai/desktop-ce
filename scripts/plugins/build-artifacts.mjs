#!/usr/bin/env node

import { mkdir, readdir, rm, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pluginPackagesRoot = path.join(workspaceRoot, "packages", "plugins");
const artifactRoot = path.join(workspaceRoot, "build", "plugins");
const tempArtifactRoot = path.join(artifactRoot, ".tmp");

function readExportedPlugin(moduleExports) {
  if (
    moduleExports !== null &&
    typeof moduleExports === "object" &&
    "plugin" in moduleExports
  ) {
    return moduleExports.plugin;
  }

  if (
    moduleExports !== null &&
    typeof moduleExports === "object" &&
    "default" in moduleExports
  ) {
    return moduleExports.default;
  }

  return moduleExports;
}

function readNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin artifact is missing ${fieldName}.`);
  }

  return value.trim();
}

function yamlString(value) {
  return JSON.stringify(value);
}

function artifactUrlFor(artifactName) {
  const baseUrl = process.env.PLUGIN_ARTIFACT_BASE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    return `./${artifactName}`;
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:") {
    throw new Error("PLUGIN_ARTIFACT_BASE_URL must use HTTPS.");
  }

  return `${baseUrl.replace(/\/+$/, "")}/${artifactName}`;
}

async function listPluginPackageDirectories() {
  const entries = await readdir(pluginPackagesRoot, { withFileTypes: true });
  const directories = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDirectory = path.join(pluginPackagesRoot, entry.name);
    const pluginEntry = path.join(pluginDirectory, "src", "plugin.ts");
    try {
      const pluginEntryStat = await stat(pluginEntry);
      if (pluginEntryStat.isFile()) {
        directories.push(pluginDirectory);
      }
    } catch {
      // Ignore package-like folders that are not plugin packages.
    }
  }

  return directories.sort((left, right) => left.localeCompare(right));
}

async function buildPluginArtifact(pluginDirectory) {
  const packageName = path.basename(pluginDirectory);
  const tempArtifactPath = path.join(tempArtifactRoot, `${packageName}.plugin.js`);

  await esbuild.build({
    entryPoints: [path.join(pluginDirectory, "src", "plugin.ts")],
    outfile: tempArtifactPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: ["node22"],
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });

  const modulePath = require.resolve(tempArtifactPath);
  Reflect.deleteProperty(require.cache, modulePath);
  const plugin = readExportedPlugin(require(modulePath));
  const pluginId = readNonEmptyString(plugin?.id, "id");
  const description = readNonEmptyString(plugin?.description, "description");
  const artifactName = `${pluginId}.plugin.js`;
  const artifactPath = path.join(artifactRoot, artifactName);

  await rename(tempArtifactPath, artifactPath);

  return {
    pluginId,
    description,
    artifactName,
  };
}

function renderIndex(entries) {
  const lines = ["plugins:"];

  for (const entry of entries) {
    lines.push(`  ${entry.pluginId}:`);
    lines.push(`    description: ${yamlString(entry.description)}`);
    lines.push(`    artifactUrl: ${yamlString(artifactUrlFor(entry.artifactName))}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function main() {
  await rm(artifactRoot, { recursive: true, force: true });
  await mkdir(tempArtifactRoot, { recursive: true });

  try {
    const pluginDirectories = await listPluginPackageDirectories();
    const entries = [];

    for (const pluginDirectory of pluginDirectories) {
      entries.push(await buildPluginArtifact(pluginDirectory));
    }

    await writeFile(path.join(artifactRoot, "index.yaml"), renderIndex(entries));

    process.stdout.write(
      `Built ${String(entries.length)} plugin artifacts in ${path.relative(
        workspaceRoot,
        artifactRoot,
      )}\n`,
    );
  } finally {
    await rm(tempArtifactRoot, { recursive: true, force: true });
  }
}

await main();
