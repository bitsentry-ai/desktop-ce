import { randomUUID } from "crypto";
import { getErrorMessage } from "../../shared/errors";
import {
  addStepTemplateWarnings as addSharedStepTemplateWarnings,
  bumpExecutionSnapshotVersion,
  calculateRemainingIdleTimeoutMs as calculateSharedRemainingIdleTimeoutMs,
  buildExecutionContextFromSnapshot as buildSharedExecutionContextFromSnapshot,
  cloneExecutionSnapshot as cloneSharedExecutionSnapshot,
  createExecutionSessionState as createSharedExecutionSessionState,
  createExecutionBoundarySnapshot as createSharedExecutionBoundarySnapshot,
  extractFiniteNumericMetadataValue as extractSharedFiniteNumericMetadataValue,
  findCurrentExecutionStep as findSharedCurrentExecutionStep,
  findNextExecutableStepIndex as findSharedNextExecutableStepIndex,
  hasExecutionExceededIdleTimeout as hasSharedExecutionExceededIdleTimeout,
  markExecutionCancelled as markSharedExecutionCancelled,
  markExecutionCompleted as markSharedExecutionCompleted,
  markExecutionInterrupted as markSharedExecutionInterrupted,
  markStepCompleted as markSharedStepCompleted,
  markStepFailed as markSharedStepFailed,
  markStepRunning as markSharedStepRunning,
  mergeStepMetadata as mergeSharedStepMetadata,
  redactExecutionString as redactSharedExecutionString,
} from "./execution";
import { applyRunbookLogFilter, RunbookLogFilterError } from "./log-filter";
import { SecureRedactor } from "./redactor";
import {
  TemplateResolver,
  type TemplateResolutionResult,
  type TemplateSecureValueMode,
} from "./resolver";
import { executeShellCommandTool } from "../agent-runtime/capabilities/execute-shell-command.capability";
import type { ExternalSourceRunbookQueryExecutor } from "../error-sources/desktop-external-source-runbook-query-service";
import { createDesktopNodePluginRuntimeService } from "../plugins/desktop-plugin-runtime.node";
import type { DesktopPluginRuntimeService } from "../plugins/desktop-plugin-registry";
import type { DesktopGlobalVariablesService } from "./desktop-global-variables-service";
import type { RunbookResultPersistence } from "./desktop-runbook-result.store";
import type { DesktopRunbookStore as RunbookStore } from "./desktop-runbook.store";
import { collectRunbookGlobalReferences } from "./import-export";
import type { LogFilterConfig } from "./runbooks.schemas";
import {
  DEFAULT_RUNBOOK_IDLE_TIMEOUT_MINUTES,
  normalizeJournalTimeWindowParameterValues,
  normalizeRunbookTriggerContext,
  normalizeRunbookIdleTimeout,
  parseRunbookExecutionSource,
  type RunbookActionRecord,
  type RunbookActionParameter,
  type RunbookContextV1,
  type RunbookExecutionCompletionReason,
  type RunbookExecutionRecord,
  type RunbookExecutionSource,
  type RunbookTriggerContext,
  type RunbookHttpHeader,
  type RunbookParameterValues,
  type RunbookRecord,
} from "./desktop-runbook.types";

const RUNBOOK_EXECUTION_EVENT_CHANNEL = "bitsentry:runbooks:execution";
const MAX_AI_TOOL_ITERATIONS = 8;
const MAX_STEP_OUTPUT_LENGTH = 50_000;
const HTTP_STEP_TIMEOUT_MS = 30_000;
const SHELL_STEP_EMIT_THROTTLE_MS = 250;
const MILLISECONDS_PER_MINUTE = 60_000;
const EXECUTION_CONTROL_HEARTBEAT_INTERVAL_MS = 2_000;

export type RunbookExecutionEdition = "pro" | "ce";
export type LocalAiProviderKey =
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor";

export interface LocalAiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextLimit?: number;
}

export type LocalAiStreamDelta =
  | {
      type:
        | "text"
        | "reasoning"
        | "tool_start"
        | "tool_end"
        | "command_output"
        | "status";
      text?: string;
      toolName?: string;
      status?: "started" | "completed" | "failed" | "cancelled";
    }
  | {
      type: "token_usage";
      tokenUsage: LocalAiTokenUsage;
    };

export interface LocalAiExecutionResult {
  output: string;
  sessionId?: string;
  threadId?: string;
  resumeCursor?: unknown;
  exitCode?: number;
  tokenUsage?: LocalAiTokenUsage;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
  error?: string;
}

export interface RunbookExecutionToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: RunbookExecutionToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmSelection {
  providerKey?: RunbookActionRecord["llmProviderKey"];
  model?: string;
  thinkingEnabled?: boolean;
}

export interface ChatResponse {
  content: string;
  toolCalls?: RunbookExecutionToolCall[];
  tokenUsage?: LocalAiTokenUsage;
}

export type RunbookExecutionOnDelta = (
  delta:
    | {
        type: "text" | "tool_call" | "reasoning" | "command_output";
        text?: string;
        toolCall?: RunbookExecutionToolCall;
      }
    | {
        type: "token_usage";
        tokenUsage: NonNullable<ChatResponse["tokenUsage"]>;
      },
) => void;

export interface RunbookExecutionLlmAdapter {
  chatWithTools(input: {
    messages: ChatMessage[];
    tools?: LlmToolDefinition[];
    signal: AbortSignal;
    onDelta?: RunbookExecutionOnDelta;
    llm?: LlmSelection;
    accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
    traitValues?: Record<string, string | boolean>;
  }): Promise<ChatResponse>;
}

export interface RunbookExecutionLocalAiProvider {
  execute(
    provider: LocalAiProviderKey,
    prompt: string,
    abortController: AbortController,
    onDelta?: (delta: LocalAiStreamDelta) => void,
    cwd?: string,
    model?: string,
    accessLevel?: "supervised" | "auto-accept-edits" | "full-access",
    traitValues?: Record<string, string | boolean>,
  ): Promise<LocalAiExecutionResult>;
}

export interface RunbookExecutionWindowPort {
  isDestroyed(): boolean;
  webContents: {
    send(channel: string, payload: unknown): void;
  };
}

type RunbookCancellationReason = Extract<
  RunbookExecutionCompletionReason,
  "user_cancelled" | "idle_timeout"
>;

type RunbookActionContext = RunbookContextV1["actions"][number];
type RunbookActionContextPayload = RunbookActionContext["payload"];

function isLocalLlmProviderKey(
  value: RunbookActionRecord["llmProviderKey"],
): value is LocalAiProviderKey {
  switch (value) {
    case "claude_code":
    case "codex":
    case "opencode":
    case "cursor":
      return true;
    default:
      return false;
  }
}

function formatActionStepTitle(actionIndex: number, title: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length > 0) {
    return `${String(actionIndex + 1)}. ${trimmedTitle}`;
  }

  return `${String(actionIndex + 1)}. Untitled LLM action`;
}

function parseStartSource(
  options: RunbookExecutionStartOptions | undefined,
): RunbookExecutionSource {
  const source = parseRunbookExecutionSource(options?.source ?? "manual");
  if (source === null) {
    throw new Error("Unsupported runbook execution source");
  }

  return source;
}

function normalizeStartTriggerContext(
  options: RunbookExecutionStartOptions | undefined,
): RunbookTriggerContext | undefined {
  const triggerContext = normalizeRunbookTriggerContext(
    options?.triggerContext,
  );
  if (options?.triggerContext !== undefined && triggerContext === undefined) {
    throw new Error("Unsupported runbook trigger context");
  }

  return triggerContext;
}

function assertMatchingStartIncidentThreadIds(
  incidentThreadId: string | undefined,
  triggerIncidentThreadId: string | undefined,
): void {
  if (incidentThreadId === undefined) {
    return;
  }

  if (incidentThreadId.length === 0) {
    return;
  }

  if (triggerIncidentThreadId === undefined) {
    return;
  }

  if (triggerIncidentThreadId.length === 0) {
    return;
  }

  if (incidentThreadId !== triggerIncidentThreadId) {
    throw new Error(
      "Runbook trigger context incident does not match execution incident",
    );
  }
}

function resolveStartIncidentThreadId(
  options: RunbookExecutionStartOptions | undefined,
  triggerContext: RunbookTriggerContext | undefined,
): string | undefined {
  const incidentThreadId = options?.incidentThreadId;
  const triggerIncidentThreadId = triggerContext?.incidentThreadId;
  assertMatchingStartIncidentThreadIds(
    incidentThreadId,
    triggerIncidentThreadId,
  );

  return incidentThreadId ?? triggerIncidentThreadId;
}

function attachIncidentThreadIdToTriggerContext(
  triggerContext: RunbookTriggerContext | undefined,
  incidentThreadId: string | undefined,
): RunbookTriggerContext | undefined {
  if (
    triggerContext === undefined ||
    incidentThreadId === undefined ||
    incidentThreadId.length === 0 ||
    triggerContext.incidentThreadId !== undefined
  ) {
    return triggerContext;
  }

  return { ...triggerContext, incidentThreadId };
}

function resolveStartContext(
  options: RunbookExecutionStartOptions | undefined,
): ResolvedRunbookExecutionStartContext {
  const source = parseStartSource(options);
  const requestedTriggerContext = normalizeStartTriggerContext(options);
  const incidentThreadId = resolveStartIncidentThreadId(
    options,
    requestedTriggerContext,
  );
  const triggerContext = attachIncidentThreadIdToTriggerContext(
    requestedTriggerContext,
    incidentThreadId,
  );

  return { source, incidentThreadId, triggerContext };
}

interface RunbookExecutionSession {
  resultId: string;
  incidentThreadId?: string;
  accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
  parameterValues: RunbookParameterValues;
  redactedParameterValues: RunbookParameterValues;
  secureParameterKeys: Set<string>;
  globals: Record<string, string>;
  globalDefinitions: Array<{
    key: string;
    secure?: boolean;
    description?: string;
  }>;
  secureGlobalKeys: Set<string>;
  redactor: SecureRedactor;
  snapshot: RunbookExecutionRecord;
  abortController: AbortController;
  idleTimeoutMs?: number;
  idleWatchdog?: ReturnType<typeof setTimeout>;
  cancellationReason?: RunbookCancellationReason;
  idleCancellationInFlight?: Promise<void>;
  shuttingDown?: boolean;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  controlCompleted?: boolean;
}

interface RunbookExecutionEventPayload {
  resultId: string;
  executionId: string;
  incidentThreadId?: string | null;
  execution: RunbookExecutionRecord;
}

interface WaitForCompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface WaitForCompletionState {
  settled: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  unsubscribe: (() => void) | undefined;
}

interface RunbookExecutionStartOptions {
  incidentThreadId?: string;
  parameterValues?: RunbookParameterValues;
  source?: RunbookExecutionSource;
  triggerContext?: RunbookTriggerContext;
  accessLevel?: "supervised" | "auto-accept-edits" | "full-access";
}

interface ResolvedRunbookExecutionStartContext {
  source: RunbookExecutionSource;
  incidentThreadId: string | undefined;
  triggerContext: RunbookTriggerContext | undefined;
}

type RunbookLocalAiAccessLevel = NonNullable<
  RunbookExecutionSession["accessLevel"]
>;

export function resolveRunbookLocalAiAccessLevel(
  providerKey: LocalAiProviderKey,
  accessLevel: RunbookExecutionSession["accessLevel"],
): RunbookLocalAiAccessLevel | undefined {
  if (
    (providerKey === "codex" ||
      providerKey === "opencode" ||
      providerKey === "cursor") &&
    (accessLevel === undefined || accessLevel === "supervised")
  ) {
    return "auto-accept-edits";
  }

  return accessLevel;
}

interface ResolvedTemplate {
  value: string;
  warnings: string[];
}

interface ResolvedJsonTemplate {
  value: Record<string, unknown>;
  warnings: string[];
}

interface ResolvedHttpHeaders {
  requestHeaders: Headers | undefined;
  snapshotHeaders: RunbookHttpHeader[] | undefined;
  warnings: string[];
}

interface ResolvedHttpHeader {
  header: RunbookHttpHeader;
  warnings: string[];
}

interface ResolvedHttpHeaderKey {
  key: string;
  warnings: string[];
}

type RunbookHttpRequestMethod = NonNullable<RunbookActionRecord["method"]>;

interface PreparedHttpRequest {
  url: URL;
  method: RunbookHttpRequestMethod;
  body: ResolvedTemplate | undefined;
  headers: ResolvedHttpHeaders;
}

interface PreparedAiStepInput {
  prompt: string;
  model: string | undefined;
}

interface LocalAiSnapshotThrottleState {
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ExecutedStepResult {
  output: string;
  metadata?: Record<string, unknown>;
  structuredOutput?: Record<string, unknown>;
}

export class RunbookExecutionService {
  private readonly sessions = new Map<string, RunbookExecutionSession>();
  private readonly listeners = new Set<
    (payload: RunbookExecutionEventPayload) => void
  >();
  private readonly httpTimeoutMs: number;
  private readonly runtimeOwnerId = `${String(process.pid)}:${randomUUID()}`;
  private readonly edition: RunbookExecutionEdition;

  constructor(
    private readonly store: RunbookStore,
    private readonly globalVariablesService: DesktopGlobalVariablesService,
    private readonly llmAdapter: RunbookExecutionLlmAdapter,
    private readonly externalSourceQueryExecutor: ExternalSourceRunbookQueryExecutor,
    private readonly resultStore: RunbookResultPersistence,
    private readonly windowGetter: () => RunbookExecutionWindowPort | null,
    options?: { httpTimeoutMs?: number; edition?: RunbookExecutionEdition },
    private readonly localAiProvider?: RunbookExecutionLocalAiProvider,
    private readonly pluginRuntime: DesktopPluginRuntimeService = createDesktopNodePluginRuntimeService(),
  ) {
    this.httpTimeoutMs = options?.httpTimeoutMs ?? HTTP_STEP_TIMEOUT_MS;
    this.edition = options?.edition ?? "pro";
  }

  async start(
    runbookId: string,
    options?: RunbookExecutionStartOptions,
  ): Promise<{ executionId: string; resultId: string }> {
    const runbook = await this.store.getRunbookOrThrow(runbookId);
    const rawParameterValues = this.normalizeParameterValues(
      options?.parameterValues,
    );
    const { source, incidentThreadId, triggerContext } =
      resolveStartContext(options);
    const executionId = randomUUID();
    const resultId = randomUUID();
    const resolvedGlobals =
      await this.globalVariablesService.loadResolvedGlobals();
    const context = this.toRunbookContext(runbook, resolvedGlobals.definitions);
    const idleTimeoutMinutes = this.resolveIdleTimeoutMinutes(runbook);
    const startedAt = new Date().toISOString();
    const sharedSessionState = createSharedExecutionSessionState({
      executionId,
      runbookId: runbook.id,
      incidentThreadId,
      runbookTitle: runbook.title,
      status: "running",
      startedAt,
      idleTimeoutMinutes,
      parameterValues: rawParameterValues,
      source,
      triggerContext,
      actions: runbook.actions,
      parameterDefinitions: runbook.actions.flatMap(
        (action) => action.parameters ?? [],
      ),
      globals: resolvedGlobals.values,
      globalDefinitions: resolvedGlobals.definitions,
    });

    const session: RunbookExecutionSession = {
      resultId,
      incidentThreadId,
      accessLevel: options?.accessLevel,
      parameterValues: sharedSessionState.parameterValues,
      redactedParameterValues: sharedSessionState.redactedParameterValues,
      secureParameterKeys: sharedSessionState.secureParameterKeys,
      globals: resolvedGlobals.values,
      globalDefinitions: resolvedGlobals.definitions,
      secureGlobalKeys: sharedSessionState.secureGlobalKeys,
      redactor: sharedSessionState.redactor,
      snapshot: sharedSessionState.snapshot,
      abortController: new AbortController(),
      idleTimeoutMs: sharedSessionState.idleTimeoutMs,
    };

    await this.resultStore.createRunbookResultSession({
      resultId,
      executionId,
      ownerId: this.runtimeOwnerId,
      incidentThreadId,
      runbook,
      context,
      snapshot: this.snapshotForBoundary(session),
    });

    this.sessions.set(executionId, session);
    this.startIdleWatchdog(session);
    this.startExecutionHeartbeat(session);
    await this.emitSnapshot(session);

    void this.runExecution(session, runbook);
    return { executionId, resultId };
  }

  async get(
    executionReference: string,
  ): Promise<RunbookExecutionRecord | null> {
    const inMemory = this.sessions.get(executionReference);
    if (inMemory !== undefined) return this.snapshotForBoundary(inMemory);

    const inMemoryByResultId = [...this.sessions.values()].find(
      (session) => session.resultId === executionReference,
    );
    if (inMemoryByResultId !== undefined) {
      return this.snapshotForBoundary(inMemoryByResultId);
    }

    const persistedByExecutionId =
      await this.resultStore.getExecutionSnapshotByExecutionId(
        executionReference,
      );
    if (persistedByExecutionId !== null) {
      return persistedByExecutionId;
    }

    return this.resultStore.getExecutionSnapshotByResultId(executionReference);
  }

  async getLatestForIncidentThread(
    incidentThreadId: string,
  ): Promise<RunbookExecutionRecord | null> {
    const inMemoryMatches = [...this.sessions.values()]
      .filter((session) => session.incidentThreadId === incidentThreadId)
      .sort(
        (left, right) =>
          Date.parse(right.snapshot.startedAt) -
          Date.parse(left.snapshot.startedAt),
      );

    if (inMemoryMatches.length > 0) {
      return this.snapshotForBoundary(inMemoryMatches[0]);
    }

    return this.resultStore.getLatestExecutionSnapshotByIncidentThreadId(
      incidentThreadId,
    );
  }

  subscribe(
    listener: (payload: RunbookExecutionEventPayload) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async waitForCompletion(
    executionId: string,
    options?: WaitForCompletionOptions,
  ): Promise<RunbookExecutionRecord | null> {
    const current = await this.get(executionId);
    if (current === null || current.status !== "running") {
      return current;
    }

    return this.waitForRunningCompletion(executionId, options);
  }

  private waitForRunningCompletion(
    executionId: string,
    options: WaitForCompletionOptions | undefined,
  ): Promise<RunbookExecutionRecord | null> {
    return new Promise<RunbookExecutionRecord | null>((resolve, reject) => {
      const state: WaitForCompletionState = {
        settled: false,
        timeout: null,
        unsubscribe: undefined,
      };
      const handleAbort = () => {
        this.failWaitForCompletion(
          state,
          cleanup,
          reject,
          new Error("Runbook wait cancelled"),
        );
      };
      const cleanup = () => {
        this.cleanupWaitForCompletion(state, options?.signal, handleAbort);
      };
      const finish = (result: RunbookExecutionRecord | null) => {
        this.finishWaitForCompletion(state, cleanup, resolve, result);
      };
      const fail = (error: Error) => {
        this.failWaitForCompletion(state, cleanup, reject, error);
      };

      state.unsubscribe = this.subscribe((payload) => {
        this.handleWaitForCompletionPayload(payload, executionId, finish);
      });

      if (options?.signal?.aborted === true) {
        handleAbort();
        return;
      }

      options?.signal?.addEventListener("abort", handleAbort, { once: true });
      state.timeout = this.scheduleWaitForCompletionTimeout(
        executionId,
        options?.timeoutMs,
        finish,
        fail,
      );
    });
  }

  private cleanupWaitForCompletion(
    state: WaitForCompletionState,
    signal: AbortSignal | undefined,
    handleAbort: () => void,
  ): void {
    if (state.timeout !== null) {
      clearTimeout(state.timeout);
      state.timeout = null;
    }
    signal?.removeEventListener("abort", handleAbort);
    state.unsubscribe?.();
    state.unsubscribe = undefined;
  }

  private finishWaitForCompletion(
    state: WaitForCompletionState,
    cleanup: () => void,
    resolve: (result: RunbookExecutionRecord | null) => void,
    result: RunbookExecutionRecord | null,
  ): void {
    if (state.settled) {
      return;
    }

    state.settled = true;
    cleanup();
    resolve(result);
  }

  private failWaitForCompletion(
    state: WaitForCompletionState,
    cleanup: () => void,
    reject: (error: Error) => void,
    error: Error,
  ): void {
    if (state.settled) {
      return;
    }

    state.settled = true;
    cleanup();
    reject(error);
  }

  private handleWaitForCompletionPayload(
    payload: RunbookExecutionEventPayload,
    executionId: string,
    finish: (result: RunbookExecutionRecord | null) => void,
  ): void {
    if (payload.executionId !== executionId) {
      return;
    }
    if (payload.execution.status === "running") {
      return;
    }

    finish(cloneSharedExecutionSnapshot(payload.execution));
  }

  private scheduleWaitForCompletionTimeout(
    executionId: string,
    timeoutMs: number | undefined,
    finish: (result: RunbookExecutionRecord | null) => void,
    fail: (error: Error) => void,
  ): ReturnType<typeof setTimeout> | null {
    if (typeof timeoutMs !== "number") {
      return null;
    }
    if (timeoutMs <= 0) {
      return null;
    }

    return setTimeout(() => {
      void this.get(executionId)
        .then((latest) => {
          finish(latest);
        })
        .catch((error: unknown) => {
          fail(new Error(getErrorMessage(error)));
        });
    }, timeoutMs);
  }

  async cancel(executionId: string): Promise<void> {
    await this.resultStore.requestExecutionCancellation(executionId);

    const session = this.sessions.get(executionId);
    if (session === undefined || session.snapshot.status !== "running") {
      return;
    }

    await this.cancelExecutionSession(session, "user_cancelled");
  }

  async destroy(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (
        session.snapshot.status === "running" &&
        !session.abortController.signal.aborted
      ) {
        session.shuttingDown = true;
        session.abortController.abort();
        await this.markFailedOnShutdown(session);
      }
      this.stopIdleWatchdog(session);
      this.stopExecutionHeartbeat(session);
    }
    this.sessions.clear();
  }

  private async runExecution(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
  ): Promise<void> {
    try {
      const startIndex =
        findSharedNextExecutableStepIndex(session.snapshot) ?? 0;

      for (let index = startIndex; index < runbook.actions.length; index += 1) {
        const shouldContinue = await this.executeRunbookActionAtIndex(
          session,
          runbook,
          index,
        );
        if (!shouldContinue) {
          return;
        }
      }

      await this.completeRunbookExecution(session);
    } catch (error) {
      await this.interruptRunbookExecution(session, error);
    }
  }

  private async executeRunbookActionAtIndex(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    actionIndex: number,
  ): Promise<boolean> {
    if (await this.stopExecutionIfAborted(session)) {
      return false;
    }

    const action = runbook.actions[actionIndex];
    markSharedStepRunning(
      session.snapshot,
      actionIndex,
      new Date().toISOString(),
    );
    await this.emitSnapshot(session);

    try {
      const result = await this.executeStep(
        session,
        runbook,
        action,
        actionIndex,
      );
      if (await this.stopExecutionIfAborted(session)) {
        return false;
      }

      this.markStepCompleted(session, actionIndex, result);
      await this.emitSnapshot(session);
      return true;
    } catch (error) {
      if (await this.stopExecutionIfAborted(session)) {
        return false;
      }

      await this.failStep(session, actionIndex, error);
      return false;
    }
  }

  private markStepCompleted(
    session: RunbookExecutionSession,
    actionIndex: number,
    result: ExecutedStepResult,
  ): void {
    markSharedStepCompleted(session.snapshot, actionIndex, {
      completedAt: new Date().toISOString(),
      output: redactSharedExecutionString(session.redactor, result.output),
      metadata: mergeSharedStepMetadata(
        session.redactor,
        session.snapshot.steps[actionIndex].metadata,
        result.metadata,
      ),
      structuredOutput: this.redactStructuredOutput(
        session,
        result.structuredOutput,
      ),
      exitCode: extractSharedFiniteNumericMetadataValue(
        result.metadata,
        "exitCode",
      ),
      statusCode: extractSharedFiniteNumericMetadataValue(
        result.metadata,
        "statusCode",
      ),
    });
  }

  private async failStep(
    session: RunbookExecutionSession,
    actionIndex: number,
    error: unknown,
  ): Promise<void> {
    markSharedStepFailed(session.snapshot, actionIndex, {
      completedAt: new Date().toISOString(),
      error: redactSharedExecutionString(
        session.redactor,
        getErrorMessage(error),
      ),
      completionReason: "step_failed",
    });
    this.stopIdleWatchdog(session);
    await this.emitSnapshot(session);
  }

  private async completeRunbookExecution(
    session: RunbookExecutionSession,
  ): Promise<void> {
    markSharedExecutionCompleted(session.snapshot, new Date().toISOString());
    this.stopIdleWatchdog(session);
    await this.emitSnapshot(session);
  }

  private async interruptRunbookExecution(
    session: RunbookExecutionSession,
    error: unknown,
  ): Promise<void> {
    const runningStep = findSharedCurrentExecutionStep(session.snapshot);
    const errorMessage = getErrorMessage(error);
    if (runningStep !== undefined) {
      runningStep.error = redactSharedExecutionString(
        session.redactor,
        errorMessage,
      );
    }
    markSharedExecutionInterrupted(session.snapshot, {
      completedAt: new Date().toISOString(),
      completionReason: "step_failed",
      errorMessage: redactSharedExecutionString(session.redactor, errorMessage),
    });
    this.stopIdleWatchdog(session);
    await this.emitSnapshot(session);
  }

  private async executeStep(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    actionIndex: number,
  ): Promise<ExecutedStepResult> {
    const parameters = this.parseParameters(action.parameters);

    switch (action.type) {
      case "shell": {
        const shellParameterValues = this.normalizeShellTemplateParameterValues(
          action,
          session.parameterValues,
        );
        const command = this.resolveRequiredTemplate(
          session,
          action.command,
          "Shell command",
          parameters,
          "raw",
          shellParameterValues,
        );
        this.setStepInput(session, actionIndex, {
          actionType: "shell",
          commandTemplate: action.command,
          command,
          parameterValues: session.redactedParameterValues,
        });
        await this.emitSnapshot(session);
        return this.applyConfiguredLogFilter(
          session,
          action.logFilter,
          await this.executeShellStep(session, actionIndex, command),
        );
      }
      case "llm":
        return this.applyConfiguredLogFilter(
          session,
          action.logFilter,
          await this.executeAiStep(
            session,
            runbook,
            action,
            actionIndex,
            parameters,
          ),
        );
      case "http":
        return this.applyConfiguredLogFilter(
          session,
          action.logFilter,
          await this.executeHttpStep(session, action, actionIndex, parameters),
        );
      case "plugin":
        return this.applyConfiguredLogFilter(
          session,
          action.logFilter,
          await this.executePluginStep(
            session,
            action,
            actionIndex,
            parameters,
          ),
        );
      case "external_source":
        return this.applyConfiguredLogFilter(
          session,
          action.logFilter,
          await this.executeExternalSourceStep(
            session,
            action,
            actionIndex,
            parameters,
          ),
        );
      default:
        throw new Error(`Unsupported runbook action type: ${action.type}`);
    }
  }

  private async executePluginStep(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    actionIndex: number,
    parameters: RunbookActionParameter[],
  ): Promise<ExecutedStepResult> {
    const pluginId = action.pluginId?.trim();
    if (pluginId === undefined || pluginId.length === 0) {
      throw new Error("Plugin action is missing a selected plugin");
    }

    const pluginActionId = action.pluginActionId?.trim();
    if (pluginActionId === undefined || pluginActionId.length === 0) {
      throw new Error("Plugin action is missing a selected plugin action");
    }

    const auth = this.resolveOptionalJsonTemplate(
      session,
      action.pluginAuth,
      "Plugin auth JSON",
      parameters,
    );
    const input = this.resolveOptionalJsonTemplate(
      session,
      action.pluginInput,
      "Plugin input JSON",
      parameters,
    );

    this.setStepInput(session, actionIndex, {
      actionType: "plugin",
      pluginId,
      pluginActionId,
      pluginAuthTemplate: action.pluginAuth,
      pluginAuth: auth?.value,
      pluginInputTemplate: action.pluginInput,
      pluginInput: input?.value,
      parameterValues: session.redactedParameterValues,
    });
    addSharedStepTemplateWarnings(
      session.redactor,
      session.snapshot.steps[actionIndex],
      [...(auth?.warnings ?? []), ...(input?.warnings ?? [])],
    );
    this.recordActivity(session);
    await this.emitSnapshot(session);

    const result = await this.pluginRuntime.executeAction({
      pluginId,
      actionId: pluginActionId,
      auth: auth?.value ?? {},
      input: input?.value ?? {},
    });
    this.recordActivity(session);

    if (!result.ok) {
      throw new Error(
        this.formatPluginFailure(pluginId, pluginActionId, result),
      );
    }

    return {
      output: this.formatPluginSuccess(result),
      metadata: {
        statusCode: result.status,
        pluginId,
        pluginActionId,
      },
      structuredOutput: this.structuredPluginOutput(result.data),
    };
  }

  private async executeExternalSourceStep(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    actionIndex: number,
    parameters: RunbookActionParameter[],
  ): Promise<ExecutedStepResult> {
    const sourceId = action.sourceId?.trim();
    if (sourceId === undefined || sourceId.length === 0) {
      throw new Error("External Source action is missing a selected source");
    }
    const query = this.resolveRequiredTemplate(
      session,
      action.query,
      "External Source query",
      parameters,
      "raw",
    );
    this.setStepInput(session, actionIndex, {
      actionType: "external_source",
      sourceId,
      queryTemplate: action.query,
      query,
      parameterValues: session.redactedParameterValues,
    });
    this.recordActivity(session);
    await this.emitSnapshot(session);

    try {
      const output = await this.externalSourceQueryExecutor.execute({
        sourceId,
        query,
        signal: session.abortController.signal,
      });
      this.recordActivity(session);
      return { output };
    } catch (error) {
      this.recordActivity(session);
      throw error;
    }
  }

  private async stopExecutionIfAborted(
    session: RunbookExecutionSession,
  ): Promise<boolean> {
    if (!session.abortController.signal.aborted) {
      return false;
    }

    if (session.shuttingDown === true) {
      await this.markFailedOnShutdown(session);
      return true;
    }

    await this.markCancelled(session);
    return true;
  }

  private redactStructuredOutput(
    session: RunbookExecutionSession,
    structuredOutput: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (structuredOutput === undefined) {
      return undefined;
    }

    return session.redactor.redact(structuredOutput);
  }

  private async executeShellStep(
    session: RunbookExecutionSession,
    actionIndex: number,
    command: string,
  ): Promise<ExecutedStepResult> {
    const step = session.snapshot.steps[actionIndex];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let rawOutput = "";

    const flushOutput = async () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await this.emitSnapshot(session);
    };

    const scheduleFlush = () => {
      if (flushTimer !== null) {
        return;
      }
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void this.emitSnapshot(session);
      }, SHELL_STEP_EMIT_THROTTLE_MS);
    };

    const result = await executeShellCommandTool.execute(
      {
        command,
        timeoutMs: null,
        maxOutputBytes: MAX_STEP_OUTPUT_LENGTH,
        treatTimeoutAsSuccess: false,
        treatMaxOutputAsSuccess: true,
        terminateOnMaxOutput: false,
      },
      {
        sessionId: session.snapshot.executionId,
        toolCallId: step.actionId,
        signal: session.abortController.signal,
        onChunk: (chunk: string) => {
          this.recordActivity(session);
          rawOutput = `${rawOutput}${chunk}`.slice(-MAX_STEP_OUTPUT_LENGTH);
          step.output = redactSharedExecutionString(
            session.redactor,
            rawOutput,
          );
          scheduleFlush();
        },
      },
    );

    await flushOutput();

    if (result.error !== undefined && result.error.length > 0) {
      throw new Error(result.error);
    }

    const finalOutput = result.output ?? rawOutput;
    let output = finalOutput;
    if (output.length === 0) {
      output = "Command completed with no output.";
    }

    return {
      output,
      metadata: {
        exitCode: 0,
      },
    };
  }

  private async executeHttpStep(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    actionIndex: number,
    parameters: RunbookActionParameter[],
  ): Promise<ExecutedStepResult> {
    const request = this.prepareHttpRequest(session, action, parameters);
    this.setHttpStepInput(session, action, actionIndex, request);
    this.addHttpTemplateWarnings(session, actionIndex, request);
    this.recordActivity(session);
    await this.emitSnapshot(session);

    const response = await this.sendHttpRequest(session, request);
    return this.buildHttpResult(response);
  }

  private prepareHttpRequest(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    parameters: RunbookActionParameter[],
  ): PreparedHttpRequest {
    const rawUrl = this.resolveRequiredTemplate(
      session,
      action.url,
      "HTTP URL",
      parameters,
      "raw",
    );
    const url = this.parseHttpUrl(rawUrl);
    const method = action.method ?? "GET";
    const body = this.resolveOptionalTemplate(
      session,
      action.body,
      parameters,
      "raw",
    );
    this.assertHttpRequestBodyAllowed(method, body);

    return {
      url,
      method,
      body,
      headers: this.resolveHttpHeaders(session, action.headers, parameters),
    };
  }

  private parseHttpUrl(rawUrl: string): URL {
    try {
      return new URL(rawUrl);
    } catch {
      throw new Error(`HTTP action URL is invalid: ${rawUrl}`);
    }
  }

  private assertHttpRequestBodyAllowed(
    method: RunbookHttpRequestMethod,
    body: ResolvedTemplate | undefined,
  ): void {
    if (
      method === "GET" &&
      typeof body?.value === "string" &&
      body.value.length > 0
    ) {
      throw new Error("HTTP GET actions cannot send a request body");
    }
  }

  private setHttpStepInput(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    actionIndex: number,
    request: PreparedHttpRequest,
  ): void {
    this.setStepInput(session, actionIndex, {
      actionType: "http",
      method: request.method,
      urlTemplate: action.url,
      url: request.url.toString(),
      bodyTemplate: action.body,
      body: request.body?.value,
      headersTemplate: action.headers,
      headers: request.headers.snapshotHeaders,
      parameterValues: session.redactedParameterValues,
    });
  }

  private addHttpTemplateWarnings(
    session: RunbookExecutionSession,
    actionIndex: number,
    request: PreparedHttpRequest,
  ): void {
    addSharedStepTemplateWarnings(
      session.redactor,
      session.snapshot.steps[actionIndex],
      [...(request.body?.warnings ?? []), ...request.headers.warnings],
    );
  }

  private async sendHttpRequest(
    session: RunbookExecutionSession,
    request: PreparedHttpRequest,
  ): Promise<Response> {
    const requestController = new AbortController();
    const handleSessionAbort = () => {
      requestController.abort();
    };
    const timeoutState = { timedOut: false };
    const timeout = setTimeout(() => {
      timeoutState.timedOut = true;
      requestController.abort();
    }, this.httpTimeoutMs);

    session.abortController.signal.addEventListener(
      "abort",
      handleSessionAbort,
      { once: true },
    );

    try {
      const response = await fetch(request.url.toString(), {
        method: request.method,
        headers: request.headers.requestHeaders,
        body: this.getHttpRequestBody(request),
        signal: requestController.signal,
      });
      this.recordActivity(session);
      return response;
    } catch (error) {
      this.throwHttpRequestError(session, timeoutState.timedOut, error);
    } finally {
      clearTimeout(timeout);
      session.abortController.signal.removeEventListener(
        "abort",
        handleSessionAbort,
      );
    }
  }

  private getHttpRequestBody(request: PreparedHttpRequest): string | undefined {
    if (request.method === "GET") {
      return undefined;
    }

    return request.body?.value;
  }

  private throwHttpRequestError(
    session: RunbookExecutionSession,
    timedOut: boolean,
    error: unknown,
  ): never {
    if (timedOut) {
      throw new Error(
        `HTTP request timed out after ${String(this.httpTimeoutMs)}ms`,
      );
    }
    if (session.abortController.signal.aborted) {
      throw new Error("HTTP request cancelled");
    }
    this.recordActivity(session);
    throw error;
  }

  private async buildHttpResult(
    response: Response,
  ): Promise<ExecutedStepResult> {
    const responseBody = await this.readHttpBody(response);
    const contentType = response.headers.get("content-type");
    const formattedBody = this.formatHttpBody(contentType, responseBody);

    if (!response.ok) {
      throw new Error(
        this.formatHttpFailure(
          response.status,
          response.statusText,
          formattedBody,
        ),
      );
    }

    return {
      output: this.formatHttpSuccess(
        response.status,
        response.statusText,
        contentType,
        formattedBody,
      ),
      metadata: {
        statusCode: response.status,
        contentType: contentType ?? undefined,
      },
    };
  }

  private resolveHttpHeaders(
    session: RunbookExecutionSession,
    headers: RunbookHttpHeader[] | undefined,
    parameters: RunbookActionParameter[],
  ): ResolvedHttpHeaders {
    if (headers === undefined || headers.length === 0) {
      return {
        requestHeaders: undefined,
        snapshotHeaders: undefined,
        warnings: [],
      };
    }

    const normalized = new Headers();
    const snapshotHeaders: RunbookHttpHeader[] = [];
    const warnings: string[] = [];

    for (const header of headers) {
      const resolvedHeader = this.resolveHttpHeader(
        session,
        header,
        parameters,
      );
      if (resolvedHeader === null) {
        continue;
      }

      normalized.append(resolvedHeader.header.key, resolvedHeader.header.value);
      snapshotHeaders.push(resolvedHeader.header);
      warnings.push(...resolvedHeader.warnings);
    }

    if (snapshotHeaders.length === 0) {
      return {
        requestHeaders: undefined,
        snapshotHeaders: undefined,
        warnings,
      };
    }

    return {
      requestHeaders: normalized,
      snapshotHeaders,
      warnings,
    };
  }

  private resolveHttpHeader(
    session: RunbookExecutionSession,
    header: RunbookHttpHeader,
    parameters: RunbookActionParameter[],
  ): ResolvedHttpHeader | null {
    const key = this.resolveHttpHeaderKey(session, header, parameters);
    if (key === null) {
      return null;
    }

    const value = this.resolveOptionalTemplate(
      session,
      header.value,
      parameters,
      "raw",
    );
    const normalizedValue = value?.value ?? "";
    return {
      header: {
        key: key.key,
        value: normalizedValue,
      },
      warnings: [...key.warnings, ...(value?.warnings ?? [])],
    };
  }

  private resolveHttpHeaderKey(
    session: RunbookExecutionSession,
    header: RunbookHttpHeader,
    parameters: RunbookActionParameter[],
  ): ResolvedHttpHeaderKey | null {
    const key = this.resolveOptionalTemplate(
      session,
      header.key,
      parameters,
      "raw",
    );
    const normalizedKey = key?.value.trim();
    if (normalizedKey === undefined || normalizedKey.length === 0) {
      return null;
    }

    return {
      key: normalizedKey,
      warnings: key?.warnings ?? [],
    };
  }

  private async readHttpBody(response: Response): Promise<string> {
    const bodyText = await response.text();
    return bodyText.slice(0, MAX_STEP_OUTPUT_LENGTH);
  }

  private formatHttpBody(contentType: string | null, body: string): string {
    if (body.length === 0) return "(empty body)";

    if (contentType?.toLowerCase().includes("json") === true) {
      try {
        return JSON.stringify(JSON.parse(body), null, 2).slice(
          0,
          MAX_STEP_OUTPUT_LENGTH,
        );
      } catch {
        return body;
      }
    }

    return body;
  }

  private formatHttpSuccess(
    status: number,
    statusText: string,
    contentType: string | null,
    body: string,
  ): string {
    const trimmedContentType = contentType?.trim();
    let contentTypeLabel = "(unknown)";
    if (trimmedContentType !== undefined && trimmedContentType.length > 0) {
      contentTypeLabel = trimmedContentType;
    }

    return [
      `HTTP ${String(status)} ${statusText}`.trim(),
      `Content-Type: ${contentTypeLabel}`,
      "",
      body,
    ].join("\n");
  }

  private formatHttpFailure(
    status: number,
    statusText: string,
    body: string,
  ): string {
    return [
      `HTTP request failed with ${String(status)} ${statusText}`.trim(),
      "",
      body,
    ].join("\n");
  }

  private resolveOptionalJsonTemplate(
    session: RunbookExecutionSession,
    value: string | undefined,
    fieldLabel: string,
    parameters: RunbookActionParameter[],
  ): ResolvedJsonTemplate | undefined {
    const resolved = this.resolveOptionalTemplate(
      session,
      value,
      parameters,
      "raw",
    );
    if (resolved === undefined) {
      return undefined;
    }

    const trimmed = resolved.value.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      let message = String(error);
      if (error instanceof Error) {
        message = error.message;
      }
      throw new Error(
        `${fieldLabel} must resolve to a valid JSON object: ${message}`,
      );
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${fieldLabel} must resolve to a JSON object`);
    }

    return {
      value: parsed as Record<string, unknown>,
      warnings: resolved.warnings,
    };
  }

  private formatPluginSuccess(result: {
    summary: string;
    data?: unknown;
  }): string {
    const parts = [result.summary.trim()];
    const serializedData = this.formatPluginResultData(result.data);
    if (serializedData !== undefined) {
      parts.push("", serializedData);
    }

    return parts.join("\n").trim();
  }

  private formatPluginFailure(
    pluginId: string,
    actionId: string,
    result: {
      status: number;
      summary: string;
    },
  ): string {
    const summary = result.summary.trim();
    const prefix = `Plugin action "${pluginId}/${actionId}" failed with status ${String(result.status)}`;
    if (summary.length === 0) {
      return prefix;
    }

    return `${prefix}: ${summary}`;
  }

  private formatPluginResultData(data: unknown): string | undefined {
    if (data === undefined || data === null) {
      return undefined;
    }

    if (typeof data === "string") {
      const trimmed = data.trim();
      if (trimmed.length === 0) {
        return undefined;
      }

      return trimmed;
    }

    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return `[unserializable plugin result: ${Object.prototype.toString.call(data)}]`;
    }
  }

  private structuredPluginOutput(
    data: unknown,
  ): Record<string, unknown> | undefined {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return undefined;
    }

    return data as Record<string, unknown>;
  }

  private async executeAiStep(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    actionIndex: number,
    parameters: RunbookActionParameter[],
  ): Promise<ExecutedStepResult> {
    const input = this.prepareAiStepInput(
      session,
      action,
      actionIndex,
      parameters,
    );
    await this.emitSnapshot(session);

    if (this.shouldUseDedicatedLocalAiExecution(action)) {
      return this.executeLocalAiStep(
        session,
        runbook,
        action,
        actionIndex,
        input.prompt,
        input.model,
      );
    }

    this.assertRemoteProviderAvailable(action.llmProviderKey);
    return this.executeRemoteAiStep(
      session,
      runbook,
      action,
      actionIndex,
      input,
    );
  }

  private prepareAiStepInput(
    session: RunbookExecutionSession,
    action: RunbookActionRecord,
    actionIndex: number,
    parameters: RunbookActionParameter[],
  ): PreparedAiStepInput {
    const prompt = this.resolveRequiredTemplate(
      session,
      action.prompt,
      "LLM prompt",
      parameters,
      "placeholder",
    );
    const llmModel = this.resolveOptionalTemplate(
      session,
      action.llmModel,
      parameters,
      "placeholder",
    );
    this.setStepInput(session, actionIndex, {
      actionType: "llm",
      promptTemplate: action.prompt,
      prompt,
      llmProviderKey: action.llmProviderKey,
      llmModelTemplate: action.llmModel,
      llmModel: llmModel?.value,
      parameterValues: session.redactedParameterValues,
    });
    addSharedStepTemplateWarnings(
      session.redactor,
      session.snapshot.steps[actionIndex],
      llmModel?.warnings ?? [],
    );

    return {
      prompt,
      model: llmModel?.value,
    };
  }

  private shouldUseDedicatedLocalAiExecution(
    action: RunbookActionRecord,
  ): boolean {
    if (!isLocalLlmProviderKey(action.llmProviderKey)) {
      return false;
    }

    if (this.edition === "ce") {
      return true;
    }

    return this.localAiProvider !== undefined;
  }

  private assertRemoteProviderAvailable(
    providerKey: RunbookActionRecord["llmProviderKey"],
  ): void {
    if (this.edition === "ce" && providerKey !== undefined) {
      throw new Error(
        `LLM provider "${providerKey}" is not available in SuperTerminal CE.`,
      );
    }
  }

  private async executeRemoteAiStep(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    actionIndex: number,
    input: PreparedAiStepInput,
  ): Promise<ExecutedStepResult> {
    const { prompt, model } = input;

    const llmSelection = this.createLlmSelection(action.llmProviderKey, model);
    const tools = this.buildAiTools();
    const messages: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are executing a single BitSentry runbook LLM action.",
          "Use the user prompt exactly as given.",
          "Do not execute shell, HTTP, or External Source actions.",
          "If you need prior step results or runbook details, use the provided tools.",
          "Do not assume prior outputs that you have not read through a tool call.",
          `Runbook: ${runbook.title}`,
          `Current step: ${formatActionStepTitle(actionIndex, action.title)}`,
          `Execution parameters: ${JSON.stringify(session.redactedParameterValues)}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    for (
      let iteration = 0;
      iteration < MAX_AI_TOOL_ITERATIONS;
      iteration += 1
    ) {
      if (session.abortController.signal.aborted) {
        throw new Error("LLM action cancelled");
      }

      this.recordActivity(session);
      const response = await this.llmAdapter.chatWithTools({
        messages,
        tools,
        signal: session.abortController.signal,
        onDelta: () => {
          this.recordActivity(session);
        },
        llm: llmSelection,
      });
      this.recordActivity(session);

      messages.push({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls,
      });

      if (response.toolCalls === undefined || response.toolCalls.length === 0) {
        return {
          output: this.formatLlmOutput(response.content),
        };
      }

      for (const toolCall of response.toolCalls) {
        this.recordActivity(session);
        const toolOutput = this.executeAiTool(
          session.snapshot,
          runbook,
          actionIndex,
          toolCall.name,
          toolCall.args,
        );
        this.recordActivity(session);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: toolOutput,
        });
      }
    }

    throw new Error("LLM action exceeded the maximum tool iterations");
  }

  private formatLlmOutput(output: string): string {
    const finalOutput = output.trim();
    if (finalOutput.length === 0) {
      return "LLM action completed with no output.";
    }

    return finalOutput;
  }

  private async executeLocalAiStep(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    actionIndex: number,
    prompt: string,
    model?: string,
  ): Promise<ExecutedStepResult> {
    if (this.localAiProvider === undefined) {
      let message = "Local AI provider is not available";
      if (this.edition === "ce") {
        message = "Local AI provider is not available in SuperTerminal CE.";
      }
      throw new Error(message);
    }

    const providerKey = this.resolveLocalAiProviderKey(action.llmProviderKey);
    const accessLevel = resolveRunbookLocalAiAccessLevel(
      providerKey,
      session.accessLevel,
    );
    const redactor = session.redactor;
    const fullPrompt = this.buildLocalAiPrompt(
      session,
      runbook,
      action,
      actionIndex,
      prompt,
    );
    let output = "";
    const step = session.snapshot.steps[actionIndex];
    const snapshotState: LocalAiSnapshotThrottleState = {
      pending: false,
      timer: null,
    };
    const throttledEmitSnapshot = this.createLocalAiSnapshotEmitter(
      session,
      snapshotState,
    );

    const result = await this.localAiProvider.execute(
      providerKey,
      fullPrompt,
      session.abortController,
      (delta) => {
        this.recordActivity(session);
        output = this.appendLocalAiDeltaOutput({
          delta,
          output,
          redactor,
          step,
          onSnapshotReady: throttledEmitSnapshot,
        });
      },
      undefined,
      model,
      accessLevel,
    );

    await this.flushLocalAiSnapshotEmitter(session, snapshotState);
    step.metadata = this.createLocalAiMetadata(
      step.metadata,
      providerKey,
      result,
    );

    return {
      output: this.formatLlmOutput(
        this.finalizeLocalAiOutput(output, result, redactor),
      ),
      metadata: step.metadata,
    };
  }

  private buildLocalAiPrompt(
    session: RunbookExecutionSession,
    runbook: RunbookRecord,
    action: RunbookActionRecord,
    actionIndex: number,
    prompt: string,
  ): string {
    const contextLines = [
      `You are executing a single BitSentry runbook LLM action.`,
      `Runbook: ${runbook.title}`,
      `Current step: ${formatActionStepTitle(actionIndex, action.title)}`,
      `Execution parameters: ${JSON.stringify(session.redactedParameterValues)}`,
      "",
      "Do not run shell commands, edit files, or perform any actions beyond generating a response.",
    ];
    this.addPriorLocalAiStepOutputs(session, actionIndex, contextLines);
    contextLines.push("", "User prompt:", prompt);

    return contextLines.join("\n");
  }

  private addPriorLocalAiStepOutputs(
    session: RunbookExecutionSession,
    actionIndex: number,
    contextLines: string[],
  ): void {
    const priorSteps = session.snapshot.steps
      .slice(0, actionIndex)
      .filter((step) => step.status === "completed");
    if (priorSteps.length === 0) {
      return;
    }

    contextLines.push("", "--- Prior completed step results ---");
    for (const step of priorSteps) {
      const outputPreview = (step.output ?? "").slice(0, 2000);
      contextLines.push(
        `Step ${String(step.order)}. [${step.type}] ${step.title}: ${outputPreview}`,
      );
    }
    contextLines.push("--- End prior results ---", "");
  }

  private createLocalAiSnapshotEmitter(
    session: RunbookExecutionSession,
    snapshotState: LocalAiSnapshotThrottleState,
  ): () => void {
    const snapshotThrottleMs = 250;

    return () => {
      snapshotState.pending = true;
      if (snapshotState.timer !== null) {
        return;
      }

      snapshotState.timer = setTimeout(() => {
        snapshotState.timer = null;
        if (snapshotState.pending) {
          snapshotState.pending = false;
          void this.emitSnapshot(session);
        }
      }, snapshotThrottleMs);
    };
  }

  private async flushLocalAiSnapshotEmitter(
    session: RunbookExecutionSession,
    snapshotState: LocalAiSnapshotThrottleState,
  ): Promise<void> {
    if (snapshotState.timer !== null) {
      clearTimeout(snapshotState.timer);
      snapshotState.timer = null;
    }
    if (snapshotState.pending) {
      await this.emitSnapshot(session);
    }
  }

  private finalizeLocalAiOutput(
    output: string,
    result: LocalAiExecutionResult,
    redactor: SecureRedactor,
  ): string {
    let redactedOutput = redactor.redact(output);
    if (output.trim().length === 0 && result.output.trim().length > 0) {
      redactedOutput = redactor.redact(result.output);
    }

    if (redactedOutput.length > MAX_STEP_OUTPUT_LENGTH) {
      return redactedOutput.slice(0, MAX_STEP_OUTPUT_LENGTH);
    }

    return redactedOutput;
  }

  private appendLocalAiDeltaOutput(args: {
    delta: LocalAiStreamDelta;
    output: string;
    redactor: SecureRedactor;
    step: RunbookExecutionRecord["steps"][number];
    onSnapshotReady: () => void;
  }): string {
    const { delta, redactor, step, onSnapshotReady } = args;
    let output = args.output;

    if (delta.type !== "text" && delta.type !== "command_output") {
      return output;
    }
    if (delta.text === undefined || delta.text.length === 0) {
      return output;
    }
    if (output.length >= MAX_STEP_OUTPUT_LENGTH) {
      return output;
    }

    output += delta.text;
    if (output.length > MAX_STEP_OUTPUT_LENGTH) {
      output = output.slice(0, MAX_STEP_OUTPUT_LENGTH);
    }
    // Redact the full accumulated output on each emit to catch secrets
    // that may be split across streaming deltas.
    step.output = redactor.redact(output);
    onSnapshotReady();
    return output;
  }

  private createLlmSelection(
    providerKey: RunbookActionRecord["llmProviderKey"],
    model: string | undefined,
  ): LlmSelection {
    const selection: LlmSelection = {};

    if (this.edition === "pro" && providerKey !== undefined) {
      selection.providerKey = providerKey;
    }
    if (model !== undefined && model.length > 0) {
      selection.model = model;
    }

    return selection;
  }

  private resolveLocalAiProviderKey(
    providerKey: RunbookActionRecord["llmProviderKey"],
  ): LocalAiProviderKey {
    if (
      providerKey === "claude_code" ||
      providerKey === "codex" ||
      providerKey === "opencode" ||
      providerKey === "cursor"
    ) {
      return providerKey;
    }

    throw new Error(
      "Local AI provider is required for local runbook execution",
    );
  }

  private createLocalAiMetadata(
    previousMetadata: Record<string, unknown> | undefined,
    providerKey: LocalAiProviderKey,
    result: LocalAiExecutionResult,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      ...(previousMetadata ?? {}),
      providerKey,
    };

    this.addNonEmptyLocalAiMetadata(metadata, "sessionId", result.sessionId);
    this.addNonEmptyLocalAiMetadata(metadata, "threadId", result.threadId);
    this.addDefinedLocalAiMetadata(
      metadata,
      "resumeCursor",
      result.resumeCursor,
    );
    this.addDefinedLocalAiMetadata(metadata, "cliExitCode", result.exitCode);

    return metadata;
  }

  private addNonEmptyLocalAiMetadata(
    metadata: Record<string, unknown>,
    key: "sessionId" | "threadId",
    value: string | undefined,
  ): void {
    if (value === undefined) {
      return;
    }
    if (value.length === 0) {
      return;
    }

    metadata[key] = value;
  }

  private addDefinedLocalAiMetadata(
    metadata: Record<string, unknown>,
    key: "resumeCursor" | "cliExitCode",
    value: unknown,
  ): void {
    if (value === undefined || value === null) {
      return;
    }

    metadata[key] = value;
  }

  private buildAiTools(): LlmToolDefinition[] {
    return [
      {
        name: "get_previous_result",
        description:
          "Get the most recent completed step result before the current LLM step.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "get_step_result",
        description:
          "Get a specific completed prior step result by actionId or step order.",
        inputSchema: {
          type: "object",
          properties: {
            actionId: { type: "string" },
            order: { type: "number" },
          },
          additionalProperties: false,
        },
      },
      {
        name: "list_available_results",
        description: "List completed prior step results that can be inspected.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "get_runbook_context",
        description:
          "Get the current runbook metadata and ordered step definitions.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }

  private executeAiTool(
    snapshot: RunbookExecutionRecord,
    runbook: RunbookRecord,
    actionIndex: number,
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    switch (toolName) {
      case "get_previous_result": {
        const completedSteps = snapshot.steps
          .slice(0, actionIndex)
          .filter((step) => step.status === "completed");
        const previous = completedSteps[completedSteps.length - 1];
        if (previous === undefined) {
          return JSON.stringify(
            {
              found: false,
              message: "No completed previous step result is available.",
            },
            null,
            2,
          );
        }

        return JSON.stringify(
          {
            found: true,
            result: previous,
          },
          null,
          2,
        );
      }
      case "get_step_result": {
        const order = Number(args.order);
        let actionId = "";
        if (typeof args.actionId === "string") {
          actionId = args.actionId;
        }
        const result = snapshot.steps
          .slice(0, actionIndex)
          .find(
            (step) =>
              step.status === "completed" &&
              ((actionId.length > 0 && step.actionId === actionId) ||
                (Number.isFinite(order) && step.order === order)),
          );
        if (result === undefined) {
          return JSON.stringify(
            {
              found: false,
              message: "Requested completed prior step result was not found.",
            },
            null,
            2,
          );
        }

        return JSON.stringify(
          {
            found: true,
            result,
          },
          null,
          2,
        );
      }
      case "list_available_results":
        return JSON.stringify(
          {
            results: snapshot.steps
              .slice(0, actionIndex)
              .filter((step) => step.status === "completed")
              .map((step) => ({
                actionId: step.actionId,
                order: step.order,
                type: step.type,
                title: step.title,
                outputPreview: (step.output ?? "").slice(0, 240),
              })),
          },
          null,
          2,
        );
      case "get_runbook_context":
        return JSON.stringify(this.toRunbookContext(runbook, []), null, 2);
      default:
        return JSON.stringify(
          {
            error: `Unknown AI context tool: ${toolName}`,
          },
          null,
          2,
        );
    }
  }

  private toRunbookContext(
    runbook: RunbookRecord,
    globalDefinitions: Array<{
      key: string;
      secure?: boolean;
      description?: string;
    }>,
  ): RunbookContextV1 {
    const counts: RunbookContextV1["summary"]["actionTypeCounts"] = {
      shell: 0,
      llm: 0,
      http: 0,
      plugin: 0,
      external_source: 0,
      telemetry_existing_entry: 0,
      data_source_query: 0,
      telemetry_ingest: 0,
      diagnosis_diagnose: 0,
      diagnosis_verify: 0,
      diagnosis_recommend: 0,
    };

    for (const action of runbook.actions) {
      counts[action.type] += 1;
    }

    const referencedKeys = collectRunbookGlobalReferences({
      actions: runbook.actions.map((action) => ({
        type: action.type,
        title: action.title,
        command: action.command,
        prompt: action.prompt,
        url: action.url,
        body: action.body,
        query: action.query,
        headers: action.headers,
      })),
    });
    const globalDefinitionsByKey = new Map(
      globalDefinitions.map((globalDefinition) => [
        globalDefinition.key,
        globalDefinition,
      ]),
    );
    const globalReferences = referencedKeys.map((key: string) => {
      const globalDefinition = globalDefinitionsByKey.get(key);
      const reference: { key: string; secure?: true; description?: string } = {
        key,
      };

      if (globalDefinition?.secure === true) {
        reference.secure = true;
      }
      if (
        globalDefinition?.description !== undefined &&
        globalDefinition.description.length > 0
      ) {
        reference.description = globalDefinition.description;
      }

      return reference;
    });

    let summaryPurposeText = runbook.title;
    if (runbook.description.length > 0) {
      summaryPurposeText = runbook.description;
    }
    const actions = runbook.actions.map(
      (item, index): RunbookActionContext => ({
        id: item.id,
        order: index + 1,
        type: item.type,
        title: item.title,
        payload: this.toRunbookActionContextPayload(item),
      }),
    );

    const context: RunbookContextV1 = {
      format: "bitsentry.runbook.context",
      version: 1,
      runbook: {
        id: runbook.id,
        title: runbook.title,
        description: runbook.description,
        revisionNumber: runbook.revisionNumber,
        updatedAt: runbook.updatedAt,
        actionCount: runbook.actions.length,
      },
      summary: {
        purposeText: summaryPurposeText,
        actionTypeCounts: counts,
        orderedActionTitles: runbook.actions.map((action) => action.title),
      },
      actions,
    };

    if (globalReferences.length > 0) {
      context.globalReferences = globalReferences;
    }

    return context;
  }

  private toRunbookActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    switch (action.type) {
      case "shell":
        return this.toShellActionContextPayload(action);
      case "llm":
        return this.toLlmActionContextPayload(action);
      case "http":
        return this.toHttpActionContextPayload(action);
      case "plugin":
        return this.toPluginActionContextPayload(action);
      case "external_source":
        return this.toExternalSourceActionContextPayload(action);
      default:
        return this.toTelemetryActionContextPayload(action);
    }
  }

  private toShellActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.command !== undefined && action.command.length > 0) {
      payload.command = action.command;
    }

    this.addCommonActionContextPayload(payload, action);
    return payload;
  }

  private toLlmActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.prompt !== undefined && action.prompt.length > 0) {
      payload.prompt = action.prompt;
    }
    if (action.llmProviderKey !== undefined) {
      payload.llmProviderKey = action.llmProviderKey;
    }
    if (action.llmModel !== undefined && action.llmModel.length > 0) {
      payload.llmModel = action.llmModel;
    }

    this.addCommonActionContextPayload(payload, action);
    return payload;
  }

  private toHttpActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.url !== undefined && action.url.length > 0) {
      payload.url = action.url;
    }
    if (action.method !== undefined) {
      payload.method = action.method;
    }
    if (action.headers !== undefined && action.headers.length > 0) {
      payload.headers = action.headers;
    }
    if (typeof action.body === "string") {
      payload.body = action.body;
    }

    this.addCommonActionContextPayload(payload, action);
    return payload;
  }

  private toExternalSourceActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.query !== undefined && action.query.length > 0) {
      payload.query = action.query;
    }
    if (action.sourceId !== undefined && action.sourceId.length > 0) {
      payload.sourceId = action.sourceId;
    }

    this.addCommonActionContextPayload(payload, action);
    return payload;
  }

  private toPluginActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.pluginId !== undefined && action.pluginId.length > 0) {
      payload.pluginId = action.pluginId;
    }
    if (
      action.pluginActionId !== undefined &&
      action.pluginActionId.length > 0
    ) {
      payload.pluginActionId = action.pluginActionId;
    }
    if (typeof action.pluginInput === "string") {
      payload.pluginInput = action.pluginInput;
    }
    if (typeof action.pluginAuth === "string") {
      payload.pluginAuth = action.pluginAuth;
    }

    this.addCommonActionContextPayload(payload, action);
    return payload;
  }

  private addCommonActionContextPayload(
    payload: RunbookActionContextPayload,
    action: RunbookActionRecord,
  ): void {
    if (action.parameters !== undefined && action.parameters.length > 0) {
      payload.parameters = action.parameters;
    }
    if (action.logFilter !== undefined) {
      payload.logFilter = action.logFilter;
    }
  }

  private toTelemetryActionContextPayload(
    action: RunbookActionRecord,
  ): RunbookActionContextPayload {
    const payload: RunbookActionContextPayload = {};
    if (action.telemetryConfig !== undefined) {
      payload.telemetryConfig = action.telemetryConfig;
    }

    return payload;
  }

  private applyConfiguredLogFilter(
    _session: RunbookExecutionSession,
    logFilter: LogFilterConfig | undefined,
    result: ExecutedStepResult,
  ): ExecutedStepResult {
    if (logFilter === undefined) {
      return result;
    }

    try {
      const filtered = applyRunbookLogFilter(result.output, logFilter);
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          logFilter: filtered.metadata,
        },
        structuredOutput: {
          ...(result.structuredOutput ?? {}),
          ...filtered.structuredOutput,
        },
      };
    } catch (error) {
      if (error instanceof RunbookLogFilterError) {
        throw new Error(`Log filter failed: ${error.message}`);
      }
      throw error;
    }
  }

  private resolveIdleTimeoutMinutes(runbook: RunbookRecord): number {
    return (
      normalizeRunbookIdleTimeout(runbook.idleTimeout) ??
      DEFAULT_RUNBOOK_IDLE_TIMEOUT_MINUTES
    );
  }

  private startIdleWatchdog(session: RunbookExecutionSession): void {
    if (session.idleTimeoutMs === undefined || session.idleTimeoutMs <= 0) {
      return;
    }

    this.resetIdleWatchdog(session);
  }

  private resetIdleWatchdog(session: RunbookExecutionSession): void {
    if (session.idleTimeoutMs === undefined || session.idleTimeoutMs <= 0) {
      return;
    }
    if (session.snapshot.status !== "running") {
      return;
    }

    this.stopIdleWatchdog(session);
    const remainingMs = calculateSharedRemainingIdleTimeoutMs(
      session.snapshot,
      session.idleTimeoutMs,
      Date.now(),
    );

    session.idleWatchdog = setTimeout(() => {
      void this.handleIdleTimeout(session);
    }, remainingMs);
  }

  private stopIdleWatchdog(session: RunbookExecutionSession): void {
    if (session.idleWatchdog === undefined) {
      return;
    }
    clearTimeout(session.idleWatchdog);
    session.idleWatchdog = undefined;
  }

  private async handleIdleTimeout(
    session: RunbookExecutionSession,
  ): Promise<void> {
    session.idleWatchdog = undefined;
    if (
      session.idleTimeoutMs === undefined ||
      session.snapshot.status !== "running" ||
      session.shuttingDown === true
    ) {
      return;
    }

    if (
      !hasSharedExecutionExceededIdleTimeout(
        session.snapshot,
        session.idleTimeoutMs,
        Date.now(),
      )
    ) {
      this.resetIdleWatchdog(session);
      return;
    }

    if (session.idleCancellationInFlight === undefined) {
      session.idleCancellationInFlight = this.cancelExecutionSession(
        session,
        "idle_timeout",
      ).finally(() => {
        session.idleCancellationInFlight = undefined;
      });
    }
    await session.idleCancellationInFlight;
  }

  private recordActivity(
    session: RunbookExecutionSession,
    timestamp = new Date().toISOString(),
  ): void {
    session.snapshot.lastActivityAt = timestamp;
    this.resetIdleWatchdog(session);
  }

  private startExecutionHeartbeat(session: RunbookExecutionSession): void {
    this.stopExecutionHeartbeat(session);
    session.heartbeatTimer = setInterval(() => {
      void this.syncExecutionControl(session).catch(() => {
        // A transient heartbeat error should not crash the execution loop.
      });
    }, EXECUTION_CONTROL_HEARTBEAT_INTERVAL_MS);
  }

  private stopExecutionHeartbeat(session: RunbookExecutionSession): void {
    if (session.heartbeatTimer === undefined) {
      return;
    }

    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = undefined;
  }

  private async syncExecutionControl(
    session: RunbookExecutionSession,
    timestamp = new Date().toISOString(),
  ): Promise<void> {
    if (session.snapshot.status !== "running") {
      return;
    }

    await this.resultStore.touchExecutionHeartbeat(
      session.snapshot.executionId,
      this.runtimeOwnerId,
      timestamp,
    );

    const cancellationRequested =
      await this.resultStore.isExecutionCancellationRequested(
        session.snapshot.executionId,
      );
    if (!session.abortController.signal.aborted && cancellationRequested) {
      await this.cancelExecutionSession(session, "user_cancelled");
    }
  }

  private formatCancellationMessage(
    session: RunbookExecutionSession,
    reason: RunbookCancellationReason,
  ): string {
    if (reason !== "idle_timeout") {
      return "Execution cancelled";
    }

    const minutes =
      session.snapshot.idleTimeoutMinutes ??
      DEFAULT_RUNBOOK_IDLE_TIMEOUT_MINUTES;
    let unit = "minutes";
    if (minutes === 1) {
      unit = "minute";
    }

    return `Execution cancelled after ${String(minutes)} ${unit} without activity`;
  }

  private async cancelExecutionSession(
    session: RunbookExecutionSession,
    reason: RunbookCancellationReason,
  ): Promise<void> {
    if (session.snapshot.status !== "running") {
      return;
    }

    session.cancellationReason = session.cancellationReason ?? reason;
    if (!session.abortController.signal.aborted) {
      session.abortController.abort();
    }
    await this.markCancelled(session);
  }

  private async markCancelled(session: RunbookExecutionSession): Promise<void> {
    const { snapshot } = session;
    if (snapshot.status === "cancelled") {
      this.stopIdleWatchdog(session);
      await this.emitSnapshot(session);
      return;
    }

    const completedAt = new Date().toISOString();
    const reason = session.cancellationReason ?? "user_cancelled";
    markSharedExecutionCancelled(snapshot, {
      completedAt,
      completionReason: reason,
      errorMessage: redactSharedExecutionString(
        session.redactor,
        this.formatCancellationMessage(session, reason),
      ),
      preserveCompletedAt: true,
    });
    this.stopIdleWatchdog(session);
    await this.emitSnapshot(session);
  }

  private async markFailedOnShutdown(
    session: RunbookExecutionSession,
  ): Promise<void> {
    const { snapshot } = session;
    const completedAt = new Date().toISOString();
    markSharedExecutionInterrupted(snapshot, {
      completedAt,
      completionReason: "app_shutdown",
      errorMessage: redactSharedExecutionString(
        session.redactor,
        "Execution failed because the desktop app quit before completion",
      ),
      includePendingStep: true,
    });
    this.stopIdleWatchdog(session);
    await this.emitSnapshot(session);
  }

  private async emitSnapshot(session: RunbookExecutionSession): Promise<void> {
    bumpExecutionSnapshotVersion(session.snapshot);
    const snapshot = this.snapshotForBoundary(session);
    await this.resultStore.saveExecutionSnapshot(session.resultId, snapshot);
    if (snapshot.status !== "running") {
      this.stopExecutionHeartbeat(session);
      if (session.controlCompleted !== true) {
        session.controlCompleted = true;
        await this.resultStore.completeExecutionControl(
          snapshot.executionId,
          this.runtimeOwnerId,
          snapshot.completedAt ?? new Date().toISOString(),
        );
      }
    }

    const payload: RunbookExecutionEventPayload = {
      resultId: session.resultId,
      executionId: snapshot.executionId,
      incidentThreadId: session.incidentThreadId ?? null,
      execution: cloneSharedExecutionSnapshot(snapshot),
    };
    const win = this.windowGetter();
    if (win !== null && !win.isDestroyed()) {
      win.webContents.send(RUNBOOK_EXECUTION_EVENT_CHANNEL, payload);
    }
    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private parseParameters(
    value: RunbookActionRecord["parameters"],
  ): RunbookActionParameter[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const parameters: RunbookActionParameter[] = [];
    for (const parameter of value) {
      const parsedParameter = this.parseParameter(parameter);
      if (parsedParameter !== null) {
        parameters.push(parsedParameter);
      }
    }

    return parameters;
  }

  private parseParameter(
    parameter: RunbookActionParameter,
  ): RunbookActionParameter | null {
    const key = parameter.key.trim();
    if (key.length === 0) {
      return null;
    }

    const item: RunbookActionParameter = {
      id: parameter.id,
      key,
      label: key,
    };
    this.applyParameterOptions(item, parameter);

    return item;
  }

  private applyParameterOptions(
    item: RunbookActionParameter,
    parameter: RunbookActionParameter,
  ): void {
    if (parameter.label !== undefined && parameter.label.trim().length > 0) {
      item.label = parameter.label;
    }
    if (parameter.description !== undefined) {
      item.description = parameter.description;
    }
    if (parameter.secure === true) {
      item.secure = true;
    }
    if (parameter.defaultValue !== undefined && parameter.secure !== true) {
      item.defaultValue = parameter.defaultValue;
    }
    if (parameter.required !== undefined) {
      item.required = parameter.required;
    }
  }

  private resolveRequiredTemplate(
    session: RunbookExecutionSession,
    value: string | undefined,
    fieldLabel: string,
    parameters: RunbookActionParameter[],
    secureValueMode: TemplateSecureValueMode,
    parameterValuesOverride?: RunbookParameterValues,
  ): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${fieldLabel} is required`);
    }

    const resolved = this.resolveTemplate(
      session,
      value,
      parameters,
      secureValueMode,
      parameterValuesOverride,
    );
    if (resolved.missing.length > 0) {
      throw new Error(
        `${fieldLabel} is missing values for: ${resolved.missing.join(", ")}`,
      );
    }

    return resolved.value;
  }

  private resolveOptionalTemplate(
    session: RunbookExecutionSession,
    value: string | undefined,
    parameters: RunbookActionParameter[],
    secureValueMode: TemplateSecureValueMode,
    parameterValuesOverride?: RunbookParameterValues,
  ): ResolvedTemplate | undefined {
    if (typeof value !== "string") {
      return undefined;
    }

    const resolved = this.resolveTemplate(
      session,
      value,
      parameters,
      secureValueMode,
      parameterValuesOverride,
    );
    let resolvedValue = resolved.value;
    if (resolved.missing.length > 0) {
      resolvedValue = value;
    }

    return {
      value: resolvedValue,
      warnings: resolved.warnings,
    };
  }

  private resolveTemplate(
    session: RunbookExecutionSession,
    template: string,
    parameters: RunbookActionParameter[],
    secureValueMode: TemplateSecureValueMode,
    parameterValuesOverride?: RunbookParameterValues,
  ): TemplateResolutionResult {
    return new TemplateResolver({
      params: parameterValuesOverride ?? session.parameterValues,
      globals: session.globals,
      parameterDefinitions: parameters,
      globalDefinitions: session.globalDefinitions,
      secureParams: session.secureParameterKeys,
      secureGlobals: session.secureGlobalKeys,
      steps: buildSharedExecutionContextFromSnapshot(session.snapshot),
    }).resolve(template, {
      preserveMissing: true,
      secureValueMode,
    });
  }

  private normalizeShellTemplateParameterValues(
    action: RunbookActionRecord,
    parameterValues: RunbookParameterValues,
  ): RunbookParameterValues {
    const commandTemplate = action.command?.toLowerCase() ?? "";
    if (!commandTemplate.includes("journalctl")) {
      return parameterValues;
    }

    return normalizeJournalTimeWindowParameterValues(parameterValues);
  }

  private setStepInput(
    session: RunbookExecutionSession,
    actionIndex: number,
    input: Record<string, unknown>,
  ): void {
    session.snapshot.steps[actionIndex].input = session.redactor.redact(input);
  }

  private snapshotForBoundary(
    session: RunbookExecutionSession,
  ): RunbookExecutionRecord {
    return createSharedExecutionBoundarySnapshot(
      session.snapshot,
      session.redactedParameterValues,
      session.redactor,
    );
  }

  private normalizeParameterValues(
    parameterValues: RunbookParameterValues | undefined,
  ): RunbookParameterValues {
    if (parameterValues === undefined) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parameterValues).flatMap(([key, value]) => {
        const normalizedKey = key.trim();
        if (normalizedKey.length === 0 || typeof value !== "string") {
          return [];
        }
        return [[normalizedKey, value] as const];
      }),
    );
  }
}
