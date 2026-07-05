import type { AgentThreadSnapshot } from "../chat/types";
import type { AgentEvent } from "./contracts";

export interface DesktopOAuthCallbackPayload {
  url: string;
  code: string | null;
  state: string | null;
  valid: boolean;
  error?: string;
  receivedAt: string;
}

export interface DesktopNativeDialogFilter {
  name: string;
  extensions: string[];
}

export type DesktopUpdaterStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface DesktopUpdaterStateBase {
  status: DesktopUpdaterStatus;
  appVersion: string;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
}

export type DesktopLlmProviderKey =
  | "groq"
  | "kilocode"
  | "openai"
  | "anthropic"
  | "gemini"
  | "openrouter"
  | "claude_code"
  | "codex"
  | "opencode"
  | "cursor";

export interface DesktopAgentAttachment {
  id: string;
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface DesktopAgentLlmSelection {
  providerKey?: DesktopLlmProviderKey;
  model?: string;
  thinkingEnabled?: boolean;
}

export interface DesktopRunbookContextAction {
  id: string;
  type: string;
  title: string;
  command?: string;
  prompt?: string;
  url?: string;
  method?: string;
  query?: string;
  body?: string;
}

export interface DesktopRunbookContext {
  id: string;
  title: string;
  description: string;
  actions: DesktopRunbookContextAction[];
}

export interface DesktopAgentStartInput {
  prompt: string;
  timeoutMs?: number;
  attachments?: DesktopAgentAttachment[];
  llm?: DesktopAgentLlmSelection;
  runbookContext?: DesktopRunbookContext;
}

export interface DesktopAgentSendInput {
  message: string;
  sessionId?: string;
  attachments?: DesktopAgentAttachment[];
  llm?: DesktopAgentLlmSelection;
  runbookContext?: DesktopRunbookContext;
}

export interface DesktopAgentStatus<TState extends string = string> {
  sessionId: string;
  state: TState;
  startedAt: string;
  currentToolCallId: string | null;
}

export type DesktopUnknownAgentEvent = {
  type: string;
  timestamp: string;
  [key: string]: unknown;
};

export interface DesktopAgentEventEnvelope<
  TEvent = DesktopUnknownAgentEvent,
  TSnapshot = unknown,
> {
  sessionId: string;
  event: TEvent;
  snapshot?: TSnapshot;
}

export interface DesktopRunbookTriggerContext {
  entrypoint:
    | "runbooks"
    | "incident_detail"
    | "incident_workspace"
    | "diagnosis";
  needId?: string;
  needLabel?: string;
  sourceId?: string;
  sourceName?: string;
  sourceType?: "sentry" | "wazuh" | "posthog";
  incidentThreadId?: string;
}

export interface DesktopRunbookExecutionStep {
  actionId: string;
  order: number;
  type: "shell" | "llm" | "http" | "external_source";
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  streamDeltas?: Array<{
    timestamp: string;
    text: string;
    kind?: "text" | "command_output";
  }>;
}

export interface DesktopRunbookExecutionRecord {
  executionId: string;
  runbookId: string;
  incidentThreadId?: string | null;
  runbookTitle: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  completionReason?:
    | "success"
    | "step_failed"
    | "user_cancelled"
    | "idle_timeout"
    | "app_shutdown"
    | "lease_expired";
  idleTimeoutMinutes?: number;
  lastActivityAt?: string;
  source?: "manual" | "agent";
  triggerContext?: DesktopRunbookTriggerContext;
  steps: DesktopRunbookExecutionStep[];
}

export interface DesktopIncidentListItem {
  id: string;
  title: string;
  createdAt: string;
  prompt: string;
  state: string;
  archived?: boolean;
  archivedAt?: string;
  lastMessagePreview?: string | null;
}

export interface DesktopIncidentsState {
  incidents: DesktopIncidentListItem[];
  incidentMessages: Record<string, unknown[]>;
}

export interface DesktopBitsentryBridge<
  TUpdaterState extends DesktopUpdaterStateBase = DesktopUpdaterStateBase,
  TAnalyticsPlatform = string,
  TAgentState extends string = string,
  TAgentSnapshot = unknown,
  TAgentEvent = DesktopUnknownAgentEvent,
> {
  platform: {
    getVersions: () => { electron: string; chrome: string; node: string };
  };
  llm: {
    ping: (
      providerKey: string,
      config: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        requestId?: string;
      },
    ) => Promise<{
      ok: boolean;
      message: string;
      latencyMs: number;
      responseText: string;
      requestId: string;
    }>;
    onPingProgress: (
      callback: (event: {
        requestId: string;
        providerKey: string;
        level: "info" | "chunk" | "error" | "done";
        message: string;
        at: string;
      }) => void,
    ) => () => void;
    getProviders: () => Promise<
      Record<
        string,
        {
          hasApiKey: boolean;
          baseUrl: string;
          model: string;
          availableModels: string[];
          isSelectable: boolean;
          isPrimary: boolean;
        }
      >
    >;
    clearAllCredentials: () => Promise<{ ok: boolean }>;
    saveProvider: (
      providerKey: string,
      config: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        availableModels?: string[];
        isSelectable?: boolean;
        isPrimary?: boolean;
      },
    ) => Promise<{ ok: boolean }>;
    listModels: (
      providerKey: string,
      config: { apiKey?: string; baseUrl?: string },
    ) => Promise<{
      providerKey: string;
      models: string[];
      count: number;
      fetchedAt: string;
    }>;
    local: {
      getSettings: () => Promise<{
        claudeCode: { enabled: boolean; binaryPath: string; lastProbe?: unknown };
        codex: {
          enabled: boolean;
          binaryPath: string;
          codexArgs?: string[];
          lastProbe?: unknown;
        };
        opencode: {
          enabled: boolean;
          binaryPath: string;
          opencodeArgs?: string[];
          lastProbe?: unknown;
        };
        cursor: { enabled: boolean; binaryPath: string; lastProbe?: unknown };
      }>;
      saveSettings: (patch: Record<string, unknown>) => Promise<unknown>;
      probe: (provider: DesktopLlmProviderKey) => Promise<{
        installed: boolean;
        version: string | null;
        auth: { status: "authenticated" | "unauthenticated" | "unknown" };
        status: "ready" | "error" | "warning";
        errorKind?: string;
        message?: string;
      }>;
      detectBinary: (
        provider: DesktopLlmProviderKey,
        preferredBinaryPath?: string,
      ) => Promise<string | null>;
      listModels: (provider: DesktopLlmProviderKey) => Promise<string[]>;
      doctor: (provider: DesktopLlmProviderKey) => Promise<{
        provider: string;
        binaryPath: string;
        probe: unknown;
        resolvedPath?: string;
        stderrTail?: string;
      }>;
    };
  };
  sentry: {
    isEnabled: () => Promise<boolean>;
    setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
    rendererShouldInit: () => Promise<boolean>;
  };
  analytics: {
    getContext: () => Promise<{
      installationId: string | null;
      telemetryEnabled: boolean;
      shouldCaptureFirstRun: boolean;
      appVersion: string;
      releaseChannel: string;
      platform: TAnalyticsPlatform;
    }>;
    markFirstRunCaptured: () => Promise<{ ok: boolean }>;
  };
  telemetry: {
    getStatus: () => Promise<{ enabled: boolean; canDisable: boolean }>;
    setEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
  };
  database: {
    reset: () => Promise<{ ok: boolean }>;
  };
  dialog: {
    showSaveDialog: (input?: {
      defaultPath?: string;
      defaultFileName?: string;
      filters?: DesktopNativeDialogFilter[];
      trustScope?: "runbooks-export";
    }) => Promise<{ filePath: string | null; canceled: boolean }>;
    showOpenDialog: (input?: {
      defaultPath?: string;
      filters?: DesktopNativeDialogFilter[];
      properties?: string[];
      trustScope?: "runbooks-import";
    }) => Promise<{ filePaths: string[]; canceled: boolean }>;
  };
  oauth: {
    onCallback: (
      callback: (payload: DesktopOAuthCallbackPayload) => void,
    ) => () => void;
  };
  agent: {
    start: (input: DesktopAgentStartInput) => Promise<{ sessionId: string }>;
    send: (input: DesktopAgentSendInput) => Promise<{ sessionId: string }>;
    cancel: (sessionId: string) => Promise<void>;
    getStatus: (
      sessionId: string,
    ) => Promise<DesktopAgentStatus<TAgentState> | null>;
    getSnapshot: (sessionId: string) => Promise<TAgentSnapshot | null>;
    listRunbookAuthoringProposals: (input: {
      sessionId?: string;
      incidentThreadId?: string;
    }) => Promise<import("./contracts").RunbookAuthoringProposalReview[]>;
    approveRunbookAuthoringProposal: (input: {
      sessionId?: string;
      incidentThreadId?: string;
      proposalId: string;
      approvedOperationIds?: string[];
    }) => Promise<import("./contracts").RunbookAuthoringProposalDecisionResult>;
    rejectRunbookAuthoringProposal: (input: {
      sessionId?: string;
      incidentThreadId?: string;
      proposalId: string;
      reason?: string;
    }) => Promise<import("./contracts").RunbookAuthoringProposalDecisionResult>;
    requestRunbookAuthoringRevision: (input: {
      sessionId?: string;
      incidentThreadId?: string;
      proposalId: string;
      requestedEdit: string;
    }) => Promise<import("./contracts").RunbookAuthoringProposalDecisionResult>;
    onEvent: (
      callback: (
        event: DesktopAgentEventEnvelope<TAgentEvent, TAgentSnapshot>,
      ) => void,
    ) => () => void;
  };
  runbooks: {
    execute: (input: {
      runbookId: string;
      parameterValues?: Record<string, string>;
      incidentThreadId?: string;
      triggerContext?: DesktopRunbookTriggerContext;
    }) => Promise<{ executionId: string; resultId: string }>;
    getExecution: (
      executionId: string,
    ) => Promise<DesktopRunbookExecutionRecord | null>;
    cancelExecution: (executionId: string) => Promise<void>;
    onExecutionEvent: (callback: (event: {
      resultId: string;
      executionId: string;
      incidentThreadId?: string | null;
      execution: DesktopRunbookExecutionRecord;
    }) => void) => () => void;
  };
  incidents: {
    getState: () => Promise<DesktopIncidentsState>;
    replaceState: (snapshot: DesktopIncidentsState) => Promise<{
      ok: true;
      count: number;
    }>;
  };
  updater: {
    getState: () => Promise<TUpdaterState>;
    check: () => Promise<TUpdaterState>;
    download: () => Promise<{ accepted: boolean }>;
    install: () => Promise<{ accepted: boolean }>;
    onState: (callback: (state: TUpdaterState) => void) => () => void;
  };
}

export type DesktopStrictBitsentryBridge = DesktopBitsentryBridge<
  DesktopUpdaterStateBase,
  string,
  import("../chat/types").AgentSessionState,
  AgentThreadSnapshot,
  AgentEvent
>;
