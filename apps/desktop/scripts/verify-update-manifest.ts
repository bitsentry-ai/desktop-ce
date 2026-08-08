#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";

type CliOptions = {
  manifest: string;
  artifactRoot: string;
  requiredPathPrefix?: string;
  requiredArtifactPrefix?: string;
};

type RawManifest = {
  path?: unknown;
  files?: unknown;
};

type RawManifestFile = {
  url?: unknown;
};

function readOptionValue(argv: string[], index: number, optionName: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

export function parseArgs(argv: string[]): CliOptions {
  let manifest = "";
  let artifactRoot = "";
  let requiredPathPrefix = "";
  let requiredArtifactPrefix = "bitsentry-desktop-ce-";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--manifest":
        manifest = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--artifact-root":
        artifactRoot = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--required-path-prefix":
        requiredPathPrefix = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case "--required-artifact-prefix":
        requiredArtifactPrefix = readOptionValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (manifest.length === 0) throw new Error("--manifest is required");
  if (artifactRoot.length === 0) throw new Error("--artifact-root is required");
  return {
    manifest,
    artifactRoot,
    ...(requiredPathPrefix.length > 0 ? { requiredPathPrefix } : {}),
    requiredArtifactPrefix,
  };
}

function collectReferences(manifest: RawManifest): string[] {
  const references: string[] = [];

  if (typeof manifest.path === "string" && manifest.path.length > 0) {
    references.push(manifest.path);
  }

  if (Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      if (!file || typeof file !== "object") continue;
      const url = (file as RawManifestFile).url;
      if (typeof url === "string" && url.length > 0) references.push(url);
    }
  }

  return [...new Set(references)];
}

function normalizePrefix(prefix: string): string {
  let start = 0;
  let end = prefix.length;
  while (prefix[start] === "/") start += 1;
  while (end > start && prefix[end - 1] === "/") end -= 1;
  return prefix.slice(start, end);
}

function assertReferencePath(
  reference: string,
  requiredPathPrefix?: string,
  requiredArtifactPrefix = "bitsentry-desktop-ce-",
): string {
  if (
    reference.includes("://") ||
    reference.startsWith("/") ||
    reference.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Updater manifest contains an invalid relative artifact path: ${reference}`);
  }

  const normalizedReference = reference.replace(/\\/g, "/");
  if (requiredPathPrefix !== undefined) {
    const normalizedPrefix = normalizePrefix(requiredPathPrefix);
    if (!normalizedReference.startsWith(`${normalizedPrefix}/`)) {
      throw new Error(
        `Updater manifest path ${reference} does not use versioned prefix ${normalizedPrefix}`,
      );
    }
  }

  const artifactName = path.posix.basename(normalizedReference);
  if (!artifactName.startsWith(requiredArtifactPrefix)) {
    throw new Error(
      `Updater manifest references artifact outside required prefix ${requiredArtifactPrefix}: ${artifactName}`,
    );
  }

  return artifactName;
}

export function validateUpdateManifest(
  content: string,
  availableArtifactNames: ReadonlySet<string>,
  requiredPathPrefix?: string,
  requiredArtifactPrefix = "bitsentry-desktop-ce-",
): string[] {
  const parsed = parseYaml(content) as RawManifest;
  const references = collectReferences(parsed ?? {});
  if (references.length === 0) {
    throw new Error("Updater manifest contains no artifact references");
  }

  const artifactNames = references.map((reference) =>
    assertReferencePath(reference, requiredPathPrefix, requiredArtifactPrefix),
  );
  const missingArtifacts = artifactNames.filter((name) => !availableArtifactNames.has(name));
  if (missingArtifacts.length > 0) {
    throw new Error(
      `Updater manifest references missing local artifacts: ${missingArtifacts.join(", ")}`,
    );
  }

  return artifactNames;
}

async function collectArtifactNames(rootDirectory: string): Promise<Set<string>> {
  const names = new Set<string>();
  const entries = await fs.readdir(rootDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      for (const name of await collectArtifactNames(fullPath)) names.add(name);
    } else if (entry.isFile()) {
      names.add(entry.name);
    }
  }

  return names;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const manifestContent = await fs.readFile(options.manifest, "utf8");
  const artifactNames = await collectArtifactNames(options.artifactRoot);
  const references = validateUpdateManifest(
    manifestContent,
    artifactNames,
    options.requiredPathPrefix,
    options.requiredArtifactPrefix,
  );

  console.log(`Verified updater manifest references: ${references.join(", ")}`);
}

if (path.basename(process.argv[1] ?? "") === "verify-update-manifest.js") {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
