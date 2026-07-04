import log from "electron-log";
import { execFile } from "child_process";
import type {
  LocalAiProviderKey,
  LocalAiSettings,
  LocalAiStreamDelta,
  LocalAiExecutionResult,
  CLIProbeResult,
} from "./types";
import { DEFAULT_LOCAL_AI_SETTINGS } from "./types";
import {
  probeClaudeCode,
  probeCodex,
  probeOpenCode,
  probeCursor,
  detectBinary,
  doctor,
  type DoctorResult,
} from "./cli-probe.service";
import { executeClaudeCode } from "./claude-code-provider.service";
import { CodexAppServerClient } from "./codex-app-server-client";
import { executeCodex } from "./codex-provider.service";
import type { OpenCodeExecutionOptions } from "./opencode-provider.service";
import { executeCursor } from "./cursor-provider.service";
import { createCodingAgentsProcessEnv } from "./coding-agents-process-env";
import {
  createCommandInvocation,
  resolveOpenCodeWindowsBinary,
} from "./cli-binary-resolution";

const SETTINGS_KEY = "local_ai_settings";
const CLAUDE_CODE_CATALOG_MODELS = [
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-8-fast",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];
const CURSOR_CATALOG_MODELS = [
  "auto",
  "composer-2.5",
  "opus-4.8",
  "gpt-5.5",
  "fable-5",
  "sonnet-5",
  "sonnet-4.6",
  "codex-5.3",
  "opus-4.7",
  "grok-build-0.1",
];
const OPEN_CODE_MODELS_LOCK_RETRY_DELAYS_MS = [150, 350];

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

export interface CodingAgentsDebugRecorder {
  recordEvent(stage: string, data: Record<string, unknown>): void;
  recordAnomaly(stage: string, data: Record<string, unknown>): void;
}

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
}

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
  if (provider === "claude_code") return settings.claudeCode;
  if (provider === "codex") return settings.codex;
  if (provider === "opencode") return settings.opencode;
  return settings.cursor;
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

function parseOpenCodeModelList(stdout: string, stderr: string): string[] {
  const models = new Set<string>();
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || /^provider\b/i.test(trimmed)) continue;
    const match = trimmed.match(/[a-z0-9_.-]+\/[a-z0-9_.:|+-]+/i);
    if (match !== null) models.add(match[0]);
  }
  return [...models];
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
    this.clearClaudeProbeIfChanged(patch, previous);
    this.clearCodexProbeIfChanged(patch, previous);
    this.clearOpenCodeProbeIfChanged(patch, previous);
    this.clearCursorProbeIfChanged(patch, previous);
  }

  private clearClaudeProbeIfChanged(
    patch: Partial<LocalAiSettings>,
    previous: LocalAiSettings,
  ): void {
    if (patch.claudeCode?.binaryPath === undefined) {
      return;
    }

    if (patch.claudeCode.binaryPath === previous.claudeCode.binaryPath) {
      return;
    }

    delete this.settings.claudeCode.lastProbe;
    this.probeCache.delete("claude_code");
  }

  private clearCodexProbeIfChanged(
    patch: Partial<LocalAiSettings>,
    previous: LocalAiSettings,
  ): void {
    const binaryChanged =
      patch.codex?.binaryPath !== undefined &&
      patch.codex.binaryPath !== previous.codex.binaryPath;
    const argsChanged =
      patch.codex?.codexArgs !== undefined &&
      JSON.stringify(patch.codex.codexArgs) !==
        JSON.stringify(previous.codex.codexArgs);

    if (!binaryChanged && !argsChanged) {
      return;
    }

    delete this.settings.codex.lastProbe;
    this.probeCache.delete("codex");
  }

  private clearOpenCodeProbeIfChanged(
    patch: Partial<LocalAiSettings>,
    previous: LocalAiSettings,
  ): void {
    const binaryChanged =
      patch.opencode?.binaryPath !== undefined &&
      patch.opencode.binaryPath !== previous.opencode.binaryPath;
    const argsChanged =
      patch.opencode?.opencodeArgs !== undefined &&
      JSON.stringify(patch.opencode.opencodeArgs) !==
        JSON.stringify(previous.opencode.opencodeArgs);

    if (!binaryChanged && !argsChanged) {
      return;
    }

    delete this.settings.opencode.lastProbe;
    this.probeCache.delete("opencode");
  }

  private clearCursorProbeIfChanged(
    patch: Partial<LocalAiSettings>,
    previous: LocalAiSettings,
  ): void {
    if (patch.cursor?.binaryPath === undefined) {
      return;
    }

    if (patch.cursor.binaryPath === previous.cursor.binaryPath) {
      return;
    }

    delete this.settings.cursor.lastProbe;
    this.probeCache.delete("cursor");
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
    const resolved = await detectBinary(provider, preferredBinaryPath);
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
    let args: string[] | undefined;
    if (provider === "codex") {
      args = this.settings.codex.codexArgs;
    }
    if (provider === "opencode") {
      args = this.settings.opencode.opencodeArgs;
    }
    const result = await doctor(provider, settings.binaryPath, args);
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

    if (provider === "claude_code") {
      this.settings.claudeCode.lastProbe = result;
    } else if (provider === "codex") {
      this.settings.codex.lastProbe = result;
    } else if (provider === "opencode") {
      this.settings.opencode.lastProbe = result;
    } else {
      this.settings.cursor.lastProbe = result;
    }

    await this.persistSettings("persist probe state");
  }

  private async runProbe(
    provider: LocalAiProviderKey,
    binaryPath: string,
  ): Promise<CLIProbeResult> {
    if (provider === "claude_code") {
      return probeClaudeCode(binaryPath);
    }

    if (provider === "codex") {
      return probeCodex(binaryPath, this.settings.codex.codexArgs);
    }

    if (provider === "opencode") {
      return probeOpenCode(binaryPath, this.settings.opencode.opencodeArgs);
    }

    return probeCursor(binaryPath);
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
    accessLevel?: "supervised" | "auto-accept-edits" | "full-access",
    traitValues?: Record<string, string | boolean>,
  ): Promise<LocalAiExecutionResult> {
    const settings = getProviderSettings(this.settings, provider);
    if (!settings.enabled) {
      throw new Error(
        `Local AI provider "${provider}" is disabled. Enable it in Settings.`,
      );
    }
    const { binaryPath } = await this.prepareProviderForExecution(provider);

    if (provider === "claude_code") {
      return executeClaudeCode({
        prompt,
        binaryPath,
        abortController,
        cwd,
        model,
        accessLevel,
        maxTurns: effortToMaxTurns(traitValues?.effort as string | undefined),
        onDelta,
      });
    }

    if (provider === "opencode") {
      return this.dependencies.executeOpenCode({
        prompt,
        binaryPath,
        abortController,
        cwd,
        model,
        accessLevel,
        traitValues,
        opencodeArgs: this.settings.opencode.opencodeArgs,
        onDelta,
      });
    }

    if (provider === "cursor") {
      return executeCursor({
        prompt,
        binaryPath,
        abortController,
        cwd,
        model,
        accessLevel,
        traitValues,
        onDelta,
        debug: this.dependencies.debugRecorder,
      });
    }

    return executeCodex({
      prompt,
      binaryPath,
      abortController,
      cwd,
      model,
      accessLevel,
      traitValues,
      codexArgs: this.settings.codex.codexArgs,
      onDelta,
    });
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
      return [...CURSOR_CATALOG_MODELS];
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
      const detected = await detectBinary(
        "opencode",
        this.settings.opencode.binaryPath,
      );
      const binaryPath = detected ?? this.settings.opencode.binaryPath;
      const result = await this.runOpenCodeModelsCommandWithLockRetry(
        binaryPath,
        this.settings.opencode.opencodeArgs,
      );
      return parseOpenCodeModelList(result.stdout, result.stderr);
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
      client?.kill();
    }

    return [];
  }

  destroy(): void {
    this.probeCache.clear();
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
