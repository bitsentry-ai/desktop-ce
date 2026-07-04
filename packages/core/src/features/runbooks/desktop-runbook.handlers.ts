import {
  DesktopRunbookStore,
  type DesktopRunbookStoreDatabase,
  type DesktopRunbookStoreGlobalVariablesService,
} from "./desktop-runbook.store";
import {
  normalizeRunbookTriggerContext,
  parseRunbookIdleTimeoutForUpdate,
  type DesktopRunbookExportArtifactV1,
  type RunbookExecutionRecord,
  type RunbookTriggerContext,
} from "./desktop-runbook.types";
import { runbookExportArtifactV1Schema } from "./export.schemas";
import type { z } from "zod";

const SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS = {
  ce: [
    "claude_code",
    "codex",
    "opencode",
    "cursor",
  ],
  pro: [
    "groq",
    "kilocode",
    "openai",
    "anthropic",
    "gemini",
    "openrouter",
    "claude_code",
    "codex",
    "opencode",
    "cursor",
  ],
} as const;
const ALL_SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS = [
  ...SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS.pro,
] as const;

type RunbookImportIssue = z.core.$ZodIssue;
export type DesktopRunbookImportEdition =
  keyof typeof SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS;

export interface DesktopRunbookHandlerExecutionService {
  start(
    runbookId: string,
    input: {
      incidentThreadId?: string;
      parameterValues?: Record<string, string>;
      triggerContext?: RunbookTriggerContext;
      accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
    },
  ): Promise<{ executionId: string; resultId: string }>;
  get(executionId: string): Promise<RunbookExecutionRecord | null>;
  cancel(executionId: string): Promise<void>;
}

export interface DesktopRunbookHandlerGlobalVariablesService
  extends DesktopRunbookStoreGlobalVariablesService {
  update(id: string, patch: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

export interface DesktopRunbookArtifactIo {
  parseRunbookArtifactFile(raw: string): unknown;
  serializeRunbookArtifactFile(
    artifact: DesktopRunbookExportArtifactV1,
  ): string;
}

export interface DesktopRunbookHandlerFileSystem {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf-8"): Promise<void>;
}

export interface DesktopRunbookTrustedPathRuntime {
  consumeApprovedRunbookImportPath(path: string): string;
  consumeApprovedRunbookExportPath(path: string): string;
}

export interface DesktopRunbookHandlerLogger {
  warn(message: string, ...args: unknown[]): void;
}

export interface DesktopRunbookHandlersDatabase
  extends DesktopRunbookStoreDatabase {
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface DesktopRunbookHandlerDependencies {
  executionService: DesktopRunbookHandlerExecutionService;
  globalVariablesService: DesktopRunbookHandlerGlobalVariablesService;
  artifactIo: DesktopRunbookArtifactIo;
  fileSystem: DesktopRunbookHandlerFileSystem;
  trustedRunbookPaths: DesktopRunbookTrustedPathRuntime;
  logger: DesktopRunbookHandlerLogger;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asAccessLevel(
  value: unknown,
): "supervised" | "auto-accept-edits" | "full-access" | undefined {
  if (
    value === "supervised" ||
    value === "auto-accept-edits" ||
    value === "full-access"
  ) {
    return value;
  }

  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const normalized = asString(value).trim();
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return "";
}

function withOptionalStringField<T extends Record<string, unknown>>(
  value: T,
  key: string,
  fieldValue: string,
): T {
  if (fieldValue.length === 0) {
    return value;
  }

  return {
    ...value,
    [key]: fieldValue,
  };
}

function normalizeLegacyRunbookAction(rawAction: unknown): Record<string, unknown> {
  const action = asObject(rawAction);
  const sourceRef = firstNonEmptyString(action.sourceRef, action.sourceId);
  return withOptionalStringField(action, "sourceRef", sourceRef);
}

function normalizeLegacyRunbook(rawRunbook: unknown): Record<string, unknown> {
  const runbook = asObject(rawRunbook);
  if (!Array.isArray(runbook.actions)) {
    return runbook;
  }

  return {
    ...runbook,
    actions: runbook.actions.map((rawAction) =>
      normalizeLegacyRunbookAction(rawAction),
    ),
  };
}

function normalizeLegacyExternalSource(rawSource: unknown): Record<string, unknown> {
  const source = asObject(rawSource);
  const ref = firstNonEmptyString(source.ref, source.id);
  return withOptionalStringField(source, "ref", ref);
}

function normalizeLegacyRunbookImportArtifact(parsed: unknown): unknown {
  const artifact = asObject(parsed);
  const normalized = { ...artifact };
  if (Array.isArray(artifact.runbooks)) {
    normalized.runbooks = artifact.runbooks.map((rawRunbook) =>
      normalizeLegacyRunbook(rawRunbook),
    );
  }
  if (Array.isArray(artifact.externalSources)) {
    normalized.externalSources = artifact.externalSources.map((rawSource) =>
      normalizeLegacyExternalSource(rawSource),
    );
  }

  return normalized;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entries: Array<readonly [string, string]> = [];
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (normalizedKey.length > 0 && typeof rawValue === "string") {
      entries.push([normalizedKey, rawValue] as const);
    }
  }

  if (entries.length > 0) {
    return Object.fromEntries(entries);
  }

  return undefined;
}

function toGlobalVariableInput(
  value: unknown,
): Parameters<DesktopRunbookHandlerGlobalVariablesService["create"]>[0] {
  const input = asObject(value);
  const normalized: Parameters<DesktopRunbookHandlerGlobalVariablesService["create"]>[0] = {
    ...input,
    key: asString(input.key),
  };
  return normalized;
}

function validateRunbookImportArtifact(
  parsed: unknown,
  edition: DesktopRunbookImportEdition = "pro",
): DesktopRunbookExportArtifactV1 {
  const normalizedParsed = normalizeLegacyRunbookImportArtifact(parsed);
  const result = runbookExportArtifactV1Schema.safeParse(normalizedParsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      formatRunbookImportValidationError(firstIssue, normalizedParsed),
    );
  }

  assertSupportedRunbookImportProviders(result.data, edition);

  const input = asObject(normalizedParsed);
  let rawRunbooks: unknown[] = [];
  if (Array.isArray(input.runbooks)) {
    rawRunbooks = input.runbooks;
  }

  return {
    ...result.data,
    runbooks: result.data.runbooks.map((runbook, index) => {
      const rawRunbook = asObject(rawRunbooks[index]);
      const hasIdleTimeout = Object.prototype.hasOwnProperty.call(
        rawRunbook,
        "idleTimeout",
      );
      const normalizedRunbook = {
        ...runbook,
      };
      if (!hasIdleTimeout) {
        return normalizedRunbook;
      }

      return {
        ...normalizedRunbook,
        idleTimeout: parseRunbookIdleTimeoutForUpdate(rawRunbook.idleTimeout),
      };
    }),
  };
}

function assertSupportedRunbookImportProviders(
  artifact: DesktopRunbookExportArtifactV1,
  edition: DesktopRunbookImportEdition,
): void {
  const supportedProviders = SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS[edition];
  const supportedProviderSet = new Set<string>(supportedProviders);

  for (const runbook of artifact.runbooks) {
    const runbookTitle = runbook.title.trim() || "Imported runbook";
    for (const action of runbook.actions) {
      const provider =
        action.llmProviderKey?.trim() ||
        action.telemetryConfig?.llmProviderKey?.trim() ||
        "";
      if (provider.length === 0 || supportedProviderSet.has(provider)) {
        continue;
      }

      throw new Error(
        `Runbook "${runbookTitle}" action "${action.title}" uses unsupported LLM provider "${provider}". Supported providers: ${supportedProviders.join(", ")}.`,
      );
    }
  }
}

function formatRunbookImportValidationError(
  issue: RunbookImportIssue | undefined,
  artifact: unknown,
): string {
  if (issue === undefined) return "Invalid runbook import artifact";

  const actionContext = findRunbookActionContextForIssue(issue, artifact);
  if (actionContext !== undefined && issue.path.includes("llmProviderKey")) {
    const provider = firstNonEmptyString(
      actionContext.action.llmProviderKey,
      asObject(actionContext.action.telemetryConfig).llmProviderKey,
    );
    if (provider.length > 0) {
      return `Runbook "${actionContext.runbookTitle}" action "${actionContext.actionTitle}" uses unsupported LLM provider "${provider}". Supported providers: ${ALL_SUPPORTED_RUNBOOK_IMPORT_LLM_PROVIDERS.join(", ")}.`;
    }
  }

  if (issue.message.length > 0) {
    return issue.message;
  }

  return "Invalid runbook import artifact";
}

function findRunbookActionContextForIssue(
  issue: RunbookImportIssue,
  artifact: unknown,
):
  | {
      runbookTitle: string;
      actionTitle: string;
      action: Record<string, unknown>;
    }
  | undefined {
  const runbookPathIndex = issue.path.indexOf("runbooks");
  const actionPathIndex = issue.path.indexOf("actions");
  if (runbookPathIndex === -1 || actionPathIndex === -1) return undefined;

  const runbookIndex = Number(issue.path[runbookPathIndex + 1]);
  const actionIndex = Number(issue.path[actionPathIndex + 1]);
  if (!Number.isInteger(runbookIndex) || !Number.isInteger(actionIndex)) {
    return undefined;
  }

  const runbooks = asObject(artifact).runbooks;
  let runbook: Record<string, unknown> = {};
  if (Array.isArray(runbooks)) {
    runbook = asObject(runbooks[runbookIndex]);
  }
  let actions: unknown[] = [];
  if (Array.isArray(runbook.actions)) {
    actions = runbook.actions;
  }
  const action = asObject(actions[actionIndex]);
  return {
    runbookTitle: asString(runbook.title, `#${String(runbookIndex + 1)}`),
    actionTitle: asString(action.title, `#${String(actionIndex + 1)}`),
    action,
  };
}

export function createDesktopRunbookHandlers(
  db: DesktopRunbookHandlersDatabase,
  dependencies: DesktopRunbookHandlerDependencies,
  options?: {
    edition?: DesktopRunbookImportEdition;
  },
) {
  const {
    executionService,
    globalVariablesService,
    artifactIo,
    fileSystem,
    trustedRunbookPaths,
    logger,
  } = dependencies;
  const edition = options?.edition ?? "pro";
  const store = new DesktopRunbookStore(db, globalVariablesService);

  const readValidatedRunbookImportArtifact = (
    raw: string,
  ): DesktopRunbookExportArtifactV1 => {
    return validateRunbookImportArtifact(
      artifactIo.parseRunbookArtifactFile(raw),
      edition,
    );
  };

  const logRunbookAccess = async (
    action:
      | "runbook.access.view"
      | "runbook.access.execute"
      | "runbook.access.execution",
    input: {
      runbookId: string;
      executionId?: string | null;
      incidentThreadId?: string | null;
    },
  ): Promise<void> => {
    if (input.runbookId.length === 0) return;

    try {
      await db.auditLog.create({
        data: {
          action,
          userId: null,
          details: JSON.stringify({
            resourceId: input.runbookId,
            metadata: {
              runbookId: input.runbookId,
              executionId: input.executionId ?? null,
              incidentThreadId: input.incidentThreadId ?? null,
            },
          }),
        },
      });
    } catch (error) {
      logger.warn("[audit] Failed to write runbook access log:", error);
    }
  };

  return {
    "globals:list": async () => globalVariablesService.list(),
    "globals:create": async (payload: unknown) =>
      globalVariablesService.create(toGlobalVariableInput(payload)),
    "globals:update": async (payload: unknown) => {
      const input = asObject(payload);
      return globalVariablesService.update(
        asString(input.id),
        asObject(input.patch),
      );
    },
    "globals:delete": async (payload: unknown) =>
      globalVariablesService.delete(asString(asObject(payload).id)),
    "runbooks:list": async () => store.list(),
    "runbooks:get": async (payload: unknown) => {
      const runbook = await store.get(asString(asObject(payload).id));
      if (runbook !== null) {
        await logRunbookAccess("runbook.access.view", {
          runbookId: runbook.id,
        });
      }
      return runbook;
    },
    "runbooks:create": async (payload: unknown) =>
      store.create(asObject(payload)),
    "runbooks:updateMeta": async (payload: unknown) =>
      store.updateMeta(asObject(payload)),
    "runbooks:updateActions": async (payload: unknown) =>
      store.updateActions(asObject(payload)),
    "runbooks:saveAction": async (payload: unknown) =>
      store.saveAction(asObject(payload)),
    "runbooks:deleteAction": async (payload: unknown) =>
      store.deleteAction(asObject(payload)),
    "runbooks:reorderActions": async (payload: unknown) =>
      store.reorderActions(asObject(payload)),
    "runbooks:delete": async (payload: unknown) =>
      store.remove(asObject(payload)),
    "runbooks:exportContext": async (payload: unknown) =>
      store.exportContext(asObject(payload)),
    "runbooks:export": async (payload: unknown) =>
      store.exportRunbooks(asObject(payload)),
    "runbooks:exportToFile": async (payload: unknown) => {
      const input = asObject(payload);
      const artifact = await store.exportRunbooks(input);
      const filePath = trustedRunbookPaths.consumeApprovedRunbookExportPath(
        asString(input.filePath),
      );
      await fileSystem.writeFile(
        filePath,
        artifactIo.serializeRunbookArtifactFile(artifact),
        "utf-8",
      );
      return {
        ok: true as const,
        filePath,
        count: artifact.runbooks.length,
      };
    },
    "runbooks:import": async (payload: unknown) => {
      const input = asObject(payload);
      return store.importRunbooks({
        ...input,
        artifact: validateRunbookImportArtifact(input.artifact, edition),
      });
    },
    "runbooks:readImportArtifact": async (payload: unknown) => {
      const input = asObject(payload);
      const filePath = trustedRunbookPaths.consumeApprovedRunbookImportPath(
        asString(input.filePath),
      );
      const raw = await fileSystem.readFile(filePath, "utf-8");
      return readValidatedRunbookImportArtifact(raw);
    },
    "runbooks:importFromFile": async (payload: unknown) => {
      const input = asObject(payload);
      const filePath = trustedRunbookPaths.consumeApprovedRunbookImportPath(
        asString(input.filePath),
      );
      const raw = await fileSystem.readFile(filePath, "utf-8");
      return store.importRunbooks({
        artifact: readValidatedRunbookImportArtifact(raw),
        options: input.options,
      });
    },
    "runbooks:execute": async (payload: unknown) => {
      const input = asObject(payload);
      const triggerContext = normalizeRunbookTriggerContext(
        input.triggerContext,
      );
      if (Boolean(input.triggerContext) && triggerContext === undefined) {
        throw new Error("Unsupported runbook trigger context");
      }
      const runbookId = asString(input.runbookId);
      const explicitIncidentThreadId = asString(input.incidentThreadId);
      let incidentThreadId: string | undefined;
      if (explicitIncidentThreadId.length > 0) {
        incidentThreadId = explicitIncidentThreadId;
      }
      if (
        incidentThreadId === undefined &&
        triggerContext !== undefined &&
        triggerContext.incidentThreadId !== undefined &&
        triggerContext.incidentThreadId.length > 0
      ) {
        incidentThreadId = triggerContext.incidentThreadId;
      }
      const result = await executionService.start(runbookId, {
        incidentThreadId,
        parameterValues: asStringRecord(input.parameterValues),
        triggerContext,
        accessLevel: asAccessLevel(input.accessLevel),
      });
      await logRunbookAccess("runbook.access.execute", {
        runbookId,
        executionId: result.executionId,
        incidentThreadId,
      });
      return result;
    },
    "runbooks:getExecution": async (payload: unknown) => {
      const executionId = asString(asObject(payload).executionId);
      const execution = await executionService.get(executionId);
      if (execution !== null) {
        await logRunbookAccess("runbook.access.execution", {
          runbookId: execution.runbookId,
          executionId,
        });
      }
      return execution;
    },
    "runbooks:cancelExecution": async (payload: unknown) => {
      await executionService.cancel(asString(asObject(payload).executionId));
      return;
    },
  };
}
