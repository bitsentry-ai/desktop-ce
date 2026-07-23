import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// The first-party plugin index. v1 has no versioning: install fetches the
// latest, and only the latest exists. The index is a YAML file in Cloudflare
// R2, while public plugin artifacts are served from the approved Desktop CE
// GitHub Release. Override the index URL with BITSENTRY_PLUGIN_INDEX_URL (it
// must stay on the first-party R2 origin).
export const DEFAULT_PLUGIN_INDEX_URL = "https://plugins.bitsentry.ai/index.yaml";
export const DEFAULT_PLUGIN_INDEX_ORIGIN = new URL(
  DEFAULT_PLUGIN_INDEX_URL,
).origin;
export const FIRST_PARTY_PLUGIN_RELEASE_ORIGIN = "https://github.com";
export const FIRST_PARTY_PLUGIN_RELEASE_PATH =
  /^\/bitsentry-ai\/desktop-ce\/releases\/download\/[^/]+\/[^/]+\.plugin\.js$/;

export type PluginIndexEntry = {
  name: string;
  artifactUrl: string;
  description?: string;
};

export type PluginInstallRuntime = {
  installFromArtifact(input: {
    artifactBase64: string;
    installRoot?: string;
  }): Promise<{ pluginId: string; installedPath: string; extractedEntryPath: string }>;
};

function isRemoteUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

export function assertFirstPartyRemoteUrl(source: string, label: string): void {
  if (!isRemoteUrl(source)) {
    return;
  }

  const parsed = new URL(source);
  const isFirstPartyIndex = parsed.origin === DEFAULT_PLUGIN_INDEX_ORIGIN;
  const isApprovedReleaseArtifact =
    label === "artifacts" &&
    parsed.origin === FIRST_PARTY_PLUGIN_RELEASE_ORIGIN &&
    parsed.search === "" &&
    parsed.hash === "" &&
    FIRST_PARTY_PLUGIN_RELEASE_PATH.test(parsed.pathname);
  if (!isFirstPartyIndex && !isApprovedReleaseArtifact) {
    throw new Error(
      `Remote plugin ${label} must use the first-party R2 origin ${DEFAULT_PLUGIN_INDEX_ORIGIN} or the approved Desktop CE GitHub release path`,
    );
  }
}

export function resolvePluginIndexUrl(explicit?: string): string {
  const configured = explicit ?? process.env.BITSENTRY_PLUGIN_INDEX_URL;
  if (
    configured !== undefined &&
    configured.trim().length > 0 &&
    configured !== "true"
  ) {
    const indexUrl = configured.trim();
    assertFirstPartyRemoteUrl(indexUrl, "indexes");
    return indexUrl;
  }

  return DEFAULT_PLUGIN_INDEX_URL;
}

async function readTextSource(source: string): Promise<string> {
  if (isRemoteUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to download plugin index (${String(response.status)} ${response.statusText})`,
      );
    }

    return response.text();
  }

  if (source.startsWith("file://")) {
    return readFile(fileURLToPath(source), "utf-8");
  }

  return readFile(path.resolve(source), "utf-8");
}

async function readBinarySource(source: string): Promise<Buffer> {
  if (isRemoteUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(
        `Failed to download plugin artifact (${String(response.status)} ${response.statusText})`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  if (source.startsWith("file://")) {
    return readFile(fileURLToPath(source));
  }

  return readFile(path.resolve(source));
}

export function sourceRelativeUrl(source: string, relativeUrl: string): string {
  if (isRemoteUrl(relativeUrl)) {
    return relativeUrl;
  }

  if (isRemoteUrl(source)) {
    return new URL(relativeUrl, source).toString();
  }

  if (source.startsWith("file://")) {
    return path.resolve(path.dirname(fileURLToPath(source)), relativeUrl);
  }

  return path.resolve(path.dirname(path.resolve(source)), relativeUrl);
}

function readIndexEntryRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readIndexEntryName(
  fallbackName: string,
  record: Record<string, unknown>,
): string {
  const entryName = record.name;
  if (typeof entryName === "string" && entryName.trim().length > 0) {
    return entryName.trim();
  }

  const entryId = record.id;
  if (typeof entryId === "string" && entryId.trim().length > 0) {
    return entryId.trim();
  }

  return fallbackName;
}

function readIndexEntryDescription(
  record: Record<string, unknown>,
): string | undefined {
  const description = record.description;
  if (typeof description !== "string") {
    return undefined;
  }

  const normalized = description.trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function pluginIndexEntryList(entry: PluginIndexEntry | null): PluginIndexEntry[] {
  if (entry === null) {
    return [];
  }

  return [entry];
}

function parsePluginIndexEntry(
  name: string,
  value: unknown,
): PluginIndexEntry | null {
  const record = readIndexEntryRecord(value);
  if ("version" in record || "versions" in record) {
    throw new Error("Plugin index must not include version fields in v1");
  }

  const artifactUrl = record.artifactUrl ?? record.artifact_url ?? record.url;
  if (typeof artifactUrl !== "string" || artifactUrl.trim().length === 0) {
    return null;
  }

  return {
    name: readIndexEntryName(name, record),
    artifactUrl: artifactUrl.trim(),
    description: readIndexEntryDescription(record),
  };
}

export function parsePluginIndex(raw: string): PluginIndexEntry[] {
  const parsed = parseYaml(raw) as unknown;
  const root = readIndexEntryRecord(parsed);
  if ("version" in root || "versions" in root) {
    throw new Error("Plugin index must not include version fields in v1");
  }

  const plugins = root.plugins;
  if (Array.isArray(plugins)) {
    return plugins.flatMap((entry) => {
      const parsedEntry = parsePluginIndexEntry("", entry);
      return pluginIndexEntryList(parsedEntry);
    });
  }

  const pluginRecord = readIndexEntryRecord(plugins);
  return Object.entries(pluginRecord).flatMap(([name, entry]) => {
    const parsedEntry = parsePluginIndexEntry(name, entry);
    return pluginIndexEntryList(parsedEntry);
  });
}

export async function fetchPluginIndex(explicitUrl?: string): Promise<{
  entries: PluginIndexEntry[];
  indexUrl: string;
}> {
  const indexUrl = resolvePluginIndexUrl(explicitUrl);
  const raw = await readTextSource(indexUrl);
  const entries = parsePluginIndex(raw);
  for (const entry of entries) {
    assertFirstPartyRemoteUrl(
      sourceRelativeUrl(indexUrl, entry.artifactUrl),
      "artifacts",
    );
  }

  return { entries, indexUrl };
}

export async function resolvePluginIndexEntry(
  name: string,
  explicitUrl?: string,
): Promise<{ entry: PluginIndexEntry; indexUrl: string }> {
  const index = await fetchPluginIndex(explicitUrl);
  const entry = index.entries.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Plugin "${name}" was not found in the first-party index`);
  }

  return { entry, indexUrl: index.indexUrl };
}

export type InstallPluginFromIndexResult = {
  pluginId: string;
  installedPath: string;
  extractedEntryPath: string;
  name: string;
  indexUrl: string;
  artifactUrl: string;
};

export async function installPluginFromIndex(options: {
  runtime: PluginInstallRuntime;
  name: string;
  indexUrl?: string;
  installRoot?: string;
}): Promise<InstallPluginFromIndexResult> {
  const { entry, indexUrl } = await resolvePluginIndexEntry(
    options.name,
    options.indexUrl,
  );
  const artifactUrl = sourceRelativeUrl(indexUrl, entry.artifactUrl);
  const artifact = await readBinarySource(artifactUrl);
  const result = await options.runtime.installFromArtifact({
    artifactBase64: artifact.toString("base64"),
    installRoot: options.installRoot,
  });

  return { ...result, name: entry.name, indexUrl, artifactUrl };
}
