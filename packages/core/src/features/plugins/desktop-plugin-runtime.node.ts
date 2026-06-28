import { createRequire } from "node:module";
import fs from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

import type {
  DesktopPluginExecutionRequest,
  DesktopPluginExecutionResult,
  DesktopPluginFieldDefinition,
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

const githubDeploymentEventInputSchema = z.object({
  repo_fullname: z.string().min(1),
  repo_name: z.string().min(1),
  deploy_ref: z.string().min(1).default("master"),
  deploy_env: z.string().min(1).default("production"),
  deploy_sha: z.string().min(1),
  deploy_desc: z.string().min(1),
  deploy_id: z.coerce.number().int().positive(),
  ssh_url: z.string().min(1),
  creator: z.string().min(1),
  deploy_payload: z.unknown().optional(),
});

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function splitRepoFullname(repoFullname: string): {
  owner: string;
  repo: string;
} {
  const [owner, repo, ...rest] = repoFullname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (
    owner === undefined ||
    repo === undefined ||
    rest.length > 0
  ) {
    throw new Error(
      `repo_fullname must be shaped like owner/repo. Received "${repoFullname}".`,
    );
  }

  return { owner, repo };
}

function buildGitHubArchiveUrl(
  auth: Record<string, unknown>,
  repoFullname: string,
  ref: string,
): string {
  const configuredBaseUrl = readTrimmedString(auth.baseUrl);
  const baseUrl =
    configuredBaseUrl === undefined
      ? "https://api.github.com"
      : configuredBaseUrl.replace(/\/+$/, "");
  return `${baseUrl}/repos/${repoFullname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}/tarball/${encodeURIComponent(ref)}`;
}

function buildGitHubHeaders(
  auth: Record<string, unknown>,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = readTrimmedString(auth.token);
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function downloadGitHubArchive(input: {
  auth: Record<string, unknown>;
  repoFullname: string;
  ref: string;
}): Promise<Buffer> {
  const response = await fetch(
    buildGitHubArchiveUrl(input.auth, input.repoFullname, input.ref),
    {
      method: "GET",
      headers: buildGitHubHeaders(input.auth, "application/octet-stream"),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      body.trim().length > 0
        ? body.trim()
        : `Failed to download plugin archive with status ${String(response.status)}`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function collectPluginManifestPaths(rootDirectory: string): Promise<string[]> {
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

      if (entry.isFile() && entry.name === "plugin.json") {
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
}): Promise<{
  pluginId: string;
  installedPath: string;
  extractedManifestPath: string;
}> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "bitsentry-plugin-deploy-"));

  try {
    const tar = (await import(localRequire.resolve("tar"))) as {
      x(options: { file: string; cwd: string }): Promise<void>;
    };
    const archivePath = path.join(tempRoot, "plugin.tar.gz");
    const extractDirectory = path.join(tempRoot, "extract");
    await mkdir(extractDirectory, { recursive: true });
    await writeFile(archivePath, input.archive);
    await tar.x({
      file: archivePath,
      cwd: extractDirectory,
    });

    const manifestPaths = await collectPluginManifestPaths(extractDirectory);
    const manifestPath = manifestPaths[0];
    if (manifestPath === undefined) {
      throw new Error(
        "Downloaded deployment archive does not contain a plugin.json manifest.",
      );
    }

    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      id?: unknown;
    };
    const pluginId = readTrimmedString(rawManifest.id);
    if (pluginId === undefined) {
      throw new Error("Downloaded plugin manifest is missing a valid id.");
    }

    const pluginRoot = path.dirname(manifestPath);
    const installedPath = path.join(input.installRoot, pluginId);
    await mkdir(input.installRoot, { recursive: true });
    await rm(installedPath, { recursive: true, force: true });
    await cp(pluginRoot, installedPath, { recursive: true });

    return {
      pluginId,
      installedPath,
      extractedManifestPath: path.relative(extractDirectory, manifestPath),
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

function defaultLocalPluginDirectories(): string[] {
  const configured = process.env.BITSENTRY_PLUGIN_DIR;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured
      .split(path.delimiter)
      .map((directory) => directory.trim())
      .filter((directory) => directory.length > 0);
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

  return [
    resolveRepoManagedPluginDirectory(workspaceRoot),
    path.join(workspaceRoot, ".bitsentry", "plugins"),
  ];
}

function parseStoredFieldValue(
  field: DesktopPluginFieldDefinition,
  rawValue: unknown,
): unknown {
  const normalized =
    typeof rawValue === "string" ? rawValue.trim() : undefined;

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
    registry: DesktopPluginRegistry,
    private readonly storedAuthStore: DesktopPluginStoredAuthStore,
    private readonly localPluginDirectories: string[],
  ) {
    super(registry);
  }

  private reloadRegistry(): void {
    this.registry = new DesktopPluginRegistry(
      loadDesktopLocalPlugins(this.localPluginDirectories),
    );
  }

  private async executeGitHubDeploymentEvent(
    request: DesktopPluginExecutionRequest,
  ): Promise<DesktopPluginExecutionResult> {
    const input = githubDeploymentEventInputSchema.parse(request.input);
    const expectedEnvironment =
      readTrimmedString(request.auth?.deploymentEnvironment) ?? "production";

    if (input.deploy_env !== expectedEnvironment) {
      return {
        pluginId: "github",
        actionId: "deployment_event",
        ok: true,
        status: 200,
        summary: `Skipped deployment for environment "${input.deploy_env}" because the desktop runtime is configured for "${expectedEnvironment}".`,
        data: {
          matchedEnvironment: false,
          expectedEnvironment,
          deployEnvironment: input.deploy_env,
          repoFullname: input.repo_fullname,
          deployRef: input.deploy_ref,
        },
      };
    }

    const installRoot = this.localPluginDirectories[0];
    if (installRoot === undefined) {
      throw new Error("No local plugin installation directory is configured.");
    }

    const { owner, repo } = splitRepoFullname(input.repo_fullname);

    try {
      const archive = await downloadGitHubArchive({
        auth: request.auth ?? {},
        repoFullname: input.repo_fullname,
        ref: input.deploy_ref,
      });
      const installed = await installPluginFromArchive({
        archive,
        installRoot,
      });
      this.reloadRegistry();

      const deploymentStatus = await super.executeAction({
        pluginId: "github",
        actionId: "create_deployment_status",
        auth: request.auth ?? {},
        input: {
          owner,
          repo,
          deploymentId: input.deploy_id,
          state: "success",
          description: `Completed deployment of ${input.repo_fullname} on ${input.deploy_env}.`,
        },
      });

      return {
        pluginId: "github",
        actionId: "deployment_event",
        ok: true,
        status: deploymentStatus.status,
        summary: `Installed plugin "${installed.pluginId}" from ${input.repo_fullname}@${input.deploy_ref} into ${installRoot}.`,
        data: {
          matchedEnvironment: true,
          expectedEnvironment,
          deployEnvironment: input.deploy_env,
          repoFullname: input.repo_fullname,
          repoName: input.repo_name,
          deployRef: input.deploy_ref,
          deploySha: input.deploy_sha,
          deployDescription: input.deploy_desc,
          deployId: input.deploy_id,
          creator: input.creator,
          sshUrl: input.ssh_url,
          deployPayload: input.deploy_payload ?? null,
          installedPluginId: installed.pluginId,
          installedPath: installed.installedPath,
          installRoot,
          extractedManifestPath: installed.extractedManifestPath,
          deploymentStatus: deploymentStatus.data,
        },
      };
    } catch (error) {
      try {
        await super.executeAction({
          pluginId: "github",
          actionId: "create_deployment_status",
          auth: request.auth ?? {},
          input: {
            owner,
            repo,
            deploymentId: input.deploy_id,
            state: "failure",
            description: `Failed deployment of ${input.repo_fullname} on ${input.deploy_env}.`,
          },
        });
      } catch {
        // Keep the original deployment error as the primary failure signal.
      }

      throw error;
    }
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

    if (
      request.pluginId === "github" &&
      request.actionId === "deployment_event"
    ) {
      return this.executeGitHubDeploymentEvent({
        ...request,
        auth,
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
    new DesktopPluginRegistry(loadDesktopLocalPlugins(localPluginDirectories)),
    storedAuthStore,
    localPluginDirectories,
  );
}
