import { codingAgentsLogger as log } from "./logger.js";
import { execFile } from "child_process";
import type {
  LocalAiProviderKey,
  LocalAiSettings,
  LocalAiStreamDelta,
  LocalAiExecutionResult,
  CLIProbeResult,
} from "./types.js";
import { DEFAULT_LOCAL_AI_SETTINGS } from "./types.js";
import {
  probeClaudeCode,
  probeCodex,
  probeOpenCode,
  probeCursor,
  detectBinary,
  doctor,
  parseOpenCodeModelIds,
  type DoctorResult,
} from "./cli-probe.service.js";
import {
  executeClaudeCode,
  type ClaudeCodeExecutionOptions,
} from "./claude-code-provider.service.js";
import { getCatalogModelIds } from "@bitsentry-ce/components/llm/modelCatalog";
import { CodexAppServerClient } from "./codex-app-server-client.js";
import {
  executeCodex,
  type CodexExecutionOptions,
} from "./codex-provider.service.js";
import type { OpenCodeExecutionOptions } from "./opencode-provider.service.js";
import {
  executeCursor,
  type CursorExecutionOptions,
} from "./cursor-provider.service.js";
import { createCodingAgentsProcessEnv } from "./coding-agents-process-env.js";
import {
  createCommandInvocation,
  resolveOpenCodeWindowsBinary,
} from "./cli-binary-resolution.js";
import type { CodingAgentsDebugRecorder } from './coding-agents-debug-recorder.js'
import {
  HostMcpServerService,
  type HostMcpEndpoint,
} from "./host-mcp-server.service.js";
import type { HostToolContext } from "@bitsentry-ce/core/features/agent-runtime";

const SETTINGS_KEY = "local_ai_settings";
const CLAUDE_CODE_CATALOG_MODELS = getCatalogModelIds("claude_code");
const OPEN_CODE_MODELS_LOCK_RETRY_DELAYS_MS = [150, 350];

export function prependHostSystemInstructions(
  prompt: string,
  systemPrompt: string | undefined,
): string {
  const instructions = systemPrompt?.trim();
  if (instructions === undefined || instructions === "") return prompt;

  // Cursor ACP, Codex app-server, and OpenCode do not expose a supported
  // system-message field. The prompt already owns the conversation boundary.
  return [instructions, prompt].join("\n\n");
}

export interface CodingAgentsSettingsStore {
  setting: {
    findUnique(args: {
      where: { key: string };
    }): Promise<{ value?: unknown } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: string };
      update: { value: string };
    }): Promise<unknown>;
  };
}

export type { CodingAgentsDebugRecorder } from './coding-agents-debug-recorder.js'

export interface CodingAgentsErrorContext {
  provider: string;
  operation: string;
  binaryPath?: string | null;
  preferredBinaryPath?: string | null;
  resolvedPath?: string | null;
  status?: string;
  installed?: boolean;
  authStatus?: string;
  errorKind?: string;
}

export interface CodingAgentsProviderDependencies {
  executeOpenCode(
    options: OpenCodeExecutionOptions,
  ): Promise<LocalAiExecutionResult>;
  reportError(error: unknown, context: CodingAgentsErrorContext): void;
  debugRecorder?: CodingAgentsDebugRecorder;
  executeClaudeCode?: (
    options: ClaudeCodeExecutionOptions,
  ) => Promise<LocalAiExecutionResult>;
  executeCodex?: (
    options: CodexExecutionOptions,
  ) => Promise<LocalAiExecutionResult>;
  executeCursor?: (
    options: CursorExecutionOptions,
  ) => Promise<LocalAiExecutionResult>;
  probeClaudeCode?: typeof probeClaudeCode;
  probeCodex?: typeof probeCodex;
  probeOpenCode?: typeof probeOpenCode;
  probeCursor?: typeof probeCursor;
  detectBinary?: typeof detectBinary;
  doctor?: typeof doctor;
}

type ProviderSettingsKey = keyof LocalAiSettings;
type ProviderConfig = {
  provider: LocalAiProviderKey;
  settingsKey: ProviderSettingsKey;
  argsKey?: "codexArgs" | "opencodeArgs";
  probe(
    dependencies: CodingAgentsProviderDependencies,
    binaryPath: string,
    args: string[] | undefined,
  ): Promise<CLIProbeResult>;
};

const PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  {
    provider: "claude_code",
    settingsKey: "claudeCode",
    probe: (dependencies, binaryPath) =>
      (dependencies.probeClaudeCode ?? probeClaudeCode)(binaryPath),
  },
  {
    provider: "codex",
    settingsKey: "codex",
    argsKey: "codexArgs",
    probe: (dependencies, binaryPath, args) =>
      (dependencies.probeCodex ?? probeCodex)(binaryPath, args),
  },
  {
    provider: "opencode",
    settingsKey: "opencode",
    argsKey: "opencodeArgs",
    probe: (dependencies, binaryPath, args) =>
      (dependencies.probeOpenCode ?? probeOpenCode)(binaryPath, args),
  },
  {
    provider: "cursor",
    settingsKey: "cursor",
    probe: (dependencies, binaryPath) =>
      (dependencies.probeCursor ?? probeCursor)(binaryPath),
  },
];

// Claude Code's composer effort caps the agent loop; it is not a model thinking-token budget.
const EFFORT_MAX_TURNS: Record<string, number> = {
  low: 3,
  medium: 8,
  high: 16,
  xhigh: 24,
  max: 40,
  ultrathink: 64,
};

function effortToMaxTurns(effort: string | undefined): number | undefined {
  if (effort === undefined || effort === "") return undefined;
  return EFFORT_MAX_TURNS[effort];
}

function readTraitString(
  value: string | boolean | undefined,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length > 0) {
    return normalized;
  }

  return undefined;
}

function createDefaultLocalAiSettings(): LocalAiSettings {
  return structuredClone(DEFAULT_LOCAL_AI_SETTINGS);
}

function isProviderKey(value: unknown): value is LocalAiProviderKey {
  return (
    value === "claude_code" ||
    value === "codex" ||
    value === "opencode" ||
    value === "cursor"
  );
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getProviderSettings(
  settings: LocalAiSettings,
  provider: LocalAiProviderKey,
) {
  return settings[getProviderConfig(provider).settingsKey];
}

function getProviderConfig(provider: LocalAiProviderKey): ProviderConfig {
  return PROVIDER_CONFIGS.find((config) => config.provider === provider) ?? PROVIDER_CONFIGS[0];
}

function getProviderArgs(
  settings: LocalAiSettings,
  provider: LocalAiProviderKey,
): string[] | undefined {
  const config = getProviderConfig(provider);
  if (config.argsKey === undefined) return undefined;
  const value = (settings[config.settingsKey] as unknown as Record<string, unknown>)[config.argsKey];
  return Array.isArray(value) ? value as string[] : undefined;
}

function runOpenCodeModelsCommand(
  binaryPath: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const invocation = createCommandInvocation(
      resolveOpenCodeWindowsBinary(binaryPath),
      [...args, "models"],
    );
    execFile(
      invocation.command,
      invocation.args,
      {
        timeout: 10_000,
        env: createCodingAgentsProcessEnv(process.env),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          let message = "OpenCode models command failed";
          if (error instanceof Error) {
            message = error.message;
          }
          if (stderr.trim().length > 0 && !message.includes(stderr.trim())) {
            message = `${message}\n${stderr.trim()}`;
          }
          reject(new Error(message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function isOpenCodeDatabaseLockedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /\bdatabase is locked\b/i.test(error.message);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class CodingAgentsProviderService {
  private settings: LocalAiSettings = createDefaultLocalAiSettings();
  private probeCache = new Map<LocalAiProviderKey, CLIProbeResult>();
  private readonly hostMcpServer = new HostMcpServerService();
  private openCodeModelsInFlight:
    | { key: string; promise: Promise<string[]> }
    | undefined;

  constructor(
    private readonly db: CodingAgentsSettingsStore,
    private readonly dependencies: CodingAgentsProviderDependencies,
  ) {}

  async loadSettings(): Promise<LocalAiSettings> {
    try {
      const row = await this.db.setting.findUnique({
        where: { key: SETTINGS_KEY },
      });
      if (row !== null && typeof row.value === "string") {
        const parsed: unknown = JSON.parse(row.value);
        const parsedRecord = toRecord(parsed);
        const defaults = createDefaultLocalAiSettings();
        this.settings = {
          claudeCode: {
            ...defaults.claudeCode,
            ...toRecord(parsedRecord?.claudeCode),
          },
          codex: { ...defaults.codex, ...toRecord(parsedRecord?.codex) },
          opencode: {
            ...defaults.opencode,
            ...toRecord(parsedRecord?.opencode),
          },
          cursor: { ...defaults.cursor, ...toRecord(parsedRecord?.cursor) },
        };
      }
    } catch (err) {
      log.warn("[local-ai] Failed to load settings:", err);
    }
    return this.settings;
  }

  async saveSettings(
    patch: Partial<LocalAiSettings>,
  ): Promise<LocalAiSettings> {
    const prev = this.settings;
    this.settings = this.mergeSettingsPatch(patch);

    // Clear stale probe state when binary path or args change (including clearing to empty)
    this.clearStaleProbeStates(patch, prev);
    await this.persistSettings("save settings");
    return this.settings;
  }

  getSettings(): LocalAiSettings {
    return this.settings;
  }

  private mergeSettingsPatch(patch: Partial<LocalAiSettings>): LocalAiSettings {
    return {
      ...this.settings,
      ...patch,
      claudeCode: { ...this.settings.claudeCode, ...(patch.claudeCode ?? {}) },
      codex: { ...this.settings.codex, ...(patch.codex ?? {}) },
      opencode: { ...this.settings.opencode, ...(patch.opencode ?? {}) },
      cursor: { ...this.settings.cursor, ...(patch.cursor ?? {}) },
    };
  }

  private clearStaleProbeStates(
    patch: Partial<LocalAiSettings>,
    previous: LocalAiSettings,
  ): void {
    for (const config of PROVIDER_CONFIGS) {
      const patchSettings = patch[config.settingsKey] as Record<string, unknown> | undefined;
      if (patchSettings === undefined) continue;
      const previousSettings = previous[config.settingsKey] as unknown as Record<string, unknown>;
      const binaryChanged =
        patchSettings.binaryPath !== undefined &&
        patchSettings.binaryPath !== previousSettings.binaryPath;
      const argsChanged =
        config.argsKey !== undefined &&
        patchSettings[config.argsKey] !== undefined &&
        JSON.stringify(patchSettings[config.argsKey]) !== JSON.stringify(previousSettings[config.argsKey]);
      if (!binaryChanged && !argsChanged) continue;

      delete this.settings[config.settingsKey].lastProbe;
      this.probeCache.delete(config.provider);
    }
  }

  async probe(provider: LocalAiProviderKey): Promise<CLIProbeResult> {
    const settings = getProviderSettings(this.settings, provider);
    const result = await this.runProbe(provider, settings.binaryPath);
    await this.updateProbeState(provider, result);

    if (result.status === "error") {
      this.dependencies.reportError(
        new Error(result.message ?? `Local AI probe failed for ${provider}`),
        {
          provider,
          operation: "probe",
          binaryPath: settings.binaryPath,
          status: result.status,
          installed: result.installed,
          authStatus: result.auth.status,
          errorKind: result.errorKind,
        },
      );
    }

    return result;
  }

  async detect(
    provider: LocalAiProviderKey,
    preferredBinaryPath?: string,
  ): Promise<string | null> {
    const resolved = await (this.dependencies.detectBinary ?? detectBinary)(
      provider,
      preferredBinaryPath,
    );
    if (resolved === null) {
      this.dependencies.reportError(
        new Error(`Local AI binary detection failed for ${provider}`),
        {
          provider,
          operation: "detect",
          preferredBinaryPath: preferredBinaryPath ?? null,
        },
      );
    }
    return resolved;
  }

  async runDoctor(provider: LocalAiProviderKey): Promise<DoctorResult> {
    const settings = getProviderSettings(this.settings, provider);
    const args = getProviderArgs(this.settings, provider);
    const result = await (this.dependencies.doctor ?? doctor)(
      provider,
      settings.binaryPath,
      args,
    );
    if (result.probe.status === "error") {
      this.dependencies.reportError(
        new Error(
          result.probe.message ?? `Local AI doctor failed for ${provider}`,
        ),
        {
          provider,
          operation: "doctor",
          binaryPath: settings.binaryPath,
          resolvedPath: result.resolvedPath ?? null,
          errorKind: result.probe.errorKind,
        },
      );
    }
    return result;
  }

  isReady(provider: LocalAiProviderKey): boolean {
    const settings = getProviderSettings(this.settings, provider);
    if (!settings.enabled) return false;

    const probe = this.probeCache.get(provider) ?? settings.lastProbe;
    return probe?.status === "ready" || probe?.status === "warning";
  }

  isLocalProvider(providerKey: string): boolean {
    return isProviderKey(providerKey);
  }

  private async persistSettings(context: string): Promise<void> {
    try {
      await this.db.setting.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: JSON.stringify(this.settings) },
        update: { value: JSON.stringify(this.settings) },
      });
    } catch (err) {
      log.warn(`[local-ai] Failed to ${context}:`, err);
    }
  }

  private async updateProbeState(
    provider: LocalAiProviderKey,
    result: CLIProbeResult,
  ): Promise<void> {
    this.probeCache.set(provider, result);

    this.settings[getProviderConfig(provider).settingsKey].lastProbe = result;

    await this.persistSettings("persist probe state");
  }

  private async runProbe(
    provider: LocalAiProviderKey,
    binaryPath: string,
  ): Promise<CLIProbeResult> {
    const config = getProviderConfig(provider);
    return config.probe(this.dependencies, binaryPath, getProviderArgs(this.settings, provider));
  }

  private async prepareProviderForExecution(
    provider: LocalAiProviderKey,
  ): Promise<{ binaryPath: string; probe: CLIProbeResult }> {
    const settings = getProviderSettings(this.settings, provider);
    const resolvedBinaryPath = await this.detect(provider, settings.binaryPath);
    const executionBinaryPath = resolvedBinaryPath ?? settings.binaryPath;
    const probe = await this.runProbe(provider, executionBinaryPath);

    await this.updateProbeState(provider, probe);

    if (probe.status === "error") {
      throw new Error(
        probe.message ??
          `Local AI provider "${provider}" failed its startup probe.`,
      );
    }

    return {
      binaryPath: executionBinaryPath,
      probe,
    };
  }

  async execute(
    provider: LocalAiProviderKey,
    prompt: string,
    abortController: AbortController,
    onDelta?: (delta: LocalAiStreamDelta) => void,
    cwd?: string,
    model?: string,
    accessLevel?: "auto-accept-edits" | "full-access",
    traitValues?: Record<string, string | boolean>,
    hostToolContext?: HostToolContext,
    systemPrompt?: string,
  ): Promise<LocalAiExecutionResult> {
    const settings = getProviderSettings(this.settings, provider);
    if (!settings.enabled) {
      throw new Error(
        `Local AI provider "${provider}" is disabled. Enable it in Settings.`,
      );
    }
    const { binaryPath, probe } =
      await this.prepareProviderForExecution(provider);
    const mcpEndpoint = await this.createHostMcpEndpoint(
      provider,
      probe,
      accessLevel,
      hostToolContext,
    );
    const promptWithHostInstructions = prependHostSystemInstructions(
      prompt,
      systemPrompt,
    );

    try {
      if (provider === "claude_code") {
        return await (this.dependencies.executeClaudeCode ?? executeClaudeCode)({
          prompt,
          binaryPath,
          abortController,
          cwd,
          model,
          accessLevel,
          maxTurns: effortToMaxTurns(readTraitString(traitValues?.effort)),
          contextWindow: readTraitString(traitValues?.contextWindow),
          hostToolContext,
          systemPrompt,
          onDelta,
        });
      }

      if (provider === "opencode") {
        return await this.dependencies.executeOpenCode({
          prompt: promptWithHostInstructions,
          binaryPath,
          abortController,
          cwd,
          model,
          accessLevel,
          traitValues,
          opencodeArgs: this.settings.opencode.opencodeArgs,
          mcpEndpoint,
          onDelta,
        });
      }

      if (provider === "cursor") {
        return await (this.dependencies.executeCursor ?? executeCursor)({
          prompt: promptWithHostInstructions,
          binaryPath,
          abortController,
          cwd,
          model,
          accessLevel,
          traitValues,
          mcpEndpoint,
          onDelta,
          debug: this.dependencies.debugRecorder,
        });
      }

      return await (this.dependencies.executeCodex ?? executeCodex)({
        prompt,
        binaryPath,
        abortController,
        cwd,
        model,
        accessLevel,
        traitValues,
        codexArgs: this.settings.codex.codexArgs,
        mcpEndpoint,
        systemPrompt,
        onDelta,
      });
    } finally {
      if (mcpEndpoint !== undefined) this.hostMcpServer.closeSession(mcpEndpoint.token);
    }
  }

  private async createHostMcpEndpoint(
    provider: LocalAiProviderKey,
    probe: CLIProbeResult,
    accessLevel: "auto-accept-edits" | "full-access" | undefined,
    context: HostToolContext | undefined,
  ): Promise<HostMcpEndpoint | undefined> {
    if (provider === "claude_code" || context === undefined) return undefined;
    if (probe.status !== "ready" || probe.version === null) {
      throw new Error(
        `Local AI provider "${provider}" must support MCP host tools. Update the CLI and run its doctor check again.`,
      );
    }
    return await this.hostMcpServer.createSession(context);
  }

  async listModels(provider: LocalAiProviderKey): Promise<string[]> {
    if (provider === "claude_code") {
      return [...CLAUDE_CODE_CATALOG_MODELS];
    }

    if (provider === "opencode") {
      return this.listOpenCodeModels();
    }

    if (provider === "cursor") {
      // Cursor ACP can launch the browser login flow during passive model
      // discovery. Keep listing side-effect-free; execution authenticates when
      // the user intentionally runs Cursor.
      return getCatalogModelIds("cursor");
    }

    return this.listCodexModels();
  }

  private async listOpenCodeModels(): Promise<string[]> {
    const cacheKey = JSON.stringify({
      binaryPath: this.settings.opencode.binaryPath,
      args: this.settings.opencode.opencodeArgs,
    });
    if (this.openCodeModelsInFlight?.key === cacheKey) {
      return this.openCodeModelsInFlight.promise;
    }

    const promise = this.loadOpenCodeModels().finally(() => {
      if (this.openCodeModelsInFlight?.key === cacheKey) {
        this.openCodeModelsInFlight = undefined;
      }
    });
    this.openCodeModelsInFlight = { key: cacheKey, promise };
    return promise;
  }

  private async loadOpenCodeModels(): Promise<string[]> {
    try {
      const detected = await (this.dependencies.detectBinary ?? detectBinary)(
        "opencode",
        this.settings.opencode.binaryPath,
      );
      const binaryPath = detected ?? this.settings.opencode.binaryPath;
      const result = await this.runOpenCodeModelsCommandWithLockRetry(
        binaryPath,
        this.settings.opencode.opencodeArgs,
      );
      return parseOpenCodeModelIds(result.stdout, result.stderr);
    } catch (err) {
      log.warn("[local-ai] Failed to list OpenCode models:", err);
      this.dependencies.reportError(err, {
        provider: "opencode",
        operation: "listModels",
        binaryPath: this.settings.opencode.binaryPath,
      });
      return [];
    }
  }

  private async runOpenCodeModelsCommandWithLockRetry(
    binaryPath: string,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    let lastError: unknown;
    for (const delayMs of [0, ...OPEN_CODE_MODELS_LOCK_RETRY_DELAYS_MS]) {
      if (delayMs > 0) {
        await wait(delayMs);
      }

      try {
        return await runOpenCodeModelsCommand(binaryPath, args);
      } catch (err) {
        lastError = err;
        if (!isOpenCodeDatabaseLockedError(err)) {
          throw err;
        }
      }
    }

    throw lastError;
  }

  private async listCodexModels(): Promise<string[]> {
    // For Codex, try model/list via a short-lived app-server probe
    let client: CodexAppServerClient | undefined;
    try {
      const os = await import("os");
      client = new CodexAppServerClient(
        this.settings.codex.binaryPath,
        os.tmpdir(),
        this.settings.codex.codexArgs,
      );
      await client.start();
      const result = toRecord(await client.sendRequest("model/list", {}));
      const models = getModelRecords(result);
      if (models !== undefined) {
        return models
          .map(readModelId)
          .filter((id): id is string => id !== null);
      }
    } catch (err) {
      log.warn("[local-ai] Failed to list Codex models:", err);
      this.dependencies.reportError(err, {
        provider: "codex",
        operation: "listModels",
        binaryPath: this.settings.codex.binaryPath,
      });
    } finally {
      await client?.kill();
    }

    return [];
  }

  async destroy(): Promise<void> {
    this.probeCache.clear();
    await this.hostMcpServer.stop();
  }
}

function getModelRecords(
  result: Record<string, unknown> | null,
): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(result?.data)) {
    return result.data.filter(
      (entry): entry is Record<string, unknown> => toRecord(entry) !== null,
    );
  }

  if (Array.isArray(result?.models)) {
    return result.models.filter(
      (entry): entry is Record<string, unknown> => toRecord(entry) !== null,
    );
  }

  return undefined;
}

function readModelId(model: Record<string, unknown>): string | null {
  if (typeof model.model === "string") {
    return model.model;
  }

  if (typeof model.slug === "string") {
    return model.slug;
  }

  if (typeof model.id === "string") {
    return model.id;
  }

  return null;
}
