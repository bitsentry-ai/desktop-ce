/**
 * Shared types for the chat surface.
 * Extracted from packages/components/src/investigation/Incidents.tsx
 */

export type AgentSessionState =
  | "IDLE"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type DesktopIpcError = {
  code?: string;
  message?: string;
};

export type ThreadStatus =
  | "idle"
  | "blocked_no_runbook"
  | "ready"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolCallCard {
  toolCallId: string;
  toolName: string;
  state: "running" | "done" | "failed";
  error?: string;
  input?: Record<string, unknown>;
  output?: string;
  modelContext?: string;
}

export interface StreamDeltaRecord {
  timestamp: string;
  text: string;
  kind?: "text" | "command_output";
}

export interface AgentThreadTokenUsage {
  inputTokens: number;
  outputTokens: number;
  contextTokens?: number;
  contextLimit?: number;
}

export type AgentErrorCode = "NO_LLM_PROVIDER_CONFIGURED";

/**
 * A single agent loop iteration.
 * Each thinking_start creates a new iteration.
 */
export interface AgentIteration {
  id: string;
  startedAt: string;
  completedAt?: string;
  text: string;
  streamDeltas?: StreamDeltaRecord[];
  toolCallIds: string[];
  status: "thinking" | "streaming" | "done" | "error";
}

export type ChatMessage =
  | {
      kind: "user";
      text: string;
      attachments?: Array<{
        id: string;
        type: "image";
        name: string;
        mimeType: string;
        sizeBytes: number;
        dataUrl: string;
      }>;
    }
  | {
      kind: "agent";
      iterations: AgentIteration[];
      activeIterationId: string | null;
      toolCalls: ToolCallCard[];
      finalText: string | null;
      status: "thinking" | "streaming" | "done" | "error" | "cancelled";
      errorMsg?: string;
      errorCode?: AgentErrorCode;
    };

export interface AgentThreadSnapshot {
  sessionId: string;
  startedAt: string;
  runtimeState: AgentSessionState;
  threadState: AgentSessionState;
  currentToolCallId: string | null;
  messages: ChatMessage[];
  tokenUsage?: AgentThreadTokenUsage;
}

export interface SavedProviderConfig {
  hasApiKey: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  availableModels: string[];
  isSelectable: boolean;
  isPrimary: boolean;
}

export interface ComposerImageAttachment {
  id: string;
  type: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

// ---------------------------------------------------------------------------
// Access Level (ADR-0001: default is 'supervised')
// ---------------------------------------------------------------------------

/**
 * Controls how much autonomy the agent has when executing tool calls.
 *
 * - supervised:         Prompt before every tool execution.
 * - auto-accept-edits:  Allow bounded analysis/file tools, block shell execution.
 * - full-access:        Allow unrestricted tool execution including shell and HTTP.
 */
export type AccessLevel = 'supervised' | 'auto-accept-edits' | 'full-access'
export const DEFAULT_ACCESS_LEVEL: AccessLevel = 'supervised'

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  supervised: 'common.accessSelector.askFirst',
  'auto-accept-edits': 'common.accessSelector.safeTools',
  'full-access': 'common.accessSelector.allTools',
}

export const ACCESS_LEVEL_DESCRIPTIONS: Record<AccessLevel, string> = {
  supervised: 'common.accessSelector.promptsBeforeEveryToolExecution',
  'auto-accept-edits': 'common.accessSelector.allowsAnalysisToolsBlocksShell',
  'full-access': 'common.accessSelector.allowsCommandExecutionAndAll',
}

// ---------------------------------------------------------------------------
// Interaction Mode
// ---------------------------------------------------------------------------

/**
 * Controls whether the agent operates in standard mode or planning mode.
 *
 * - default: Normal assistant behavior (Build/Chat mode in T3Code)
 * - plan:    Structured planning before execution (Plan mode in T3Code)
 */
export type InteractionMode = 'default' | 'plan'
export const DEFAULT_INTERACTION_MODE: InteractionMode = 'default'

export const INTERACTION_MODE_LABELS: Record<InteractionMode, string> = {
  default: 'common.modeToggle.build',
  plan: 'common.modeToggle.plan',
}

// ---------------------------------------------------------------------------
// Option Descriptors — re-exported from modelCatalog to avoid duplication
// ---------------------------------------------------------------------------

export type {
  ComposerSelectChoice as SelectOptionChoice,
  ComposerSelectOption as SelectOptionDescriptor,
  ComposerBooleanOption as BooleanOptionDescriptor,
  ComposerOptionDescriptor as OptionDescriptor,
} from '../llm/modelCatalog'

// ---------------------------------------------------------------------------
// Well-known option IDs
// ---------------------------------------------------------------------------

/**
 * Standard option IDs used across the codebase. These match the IDs used in
 * model-catalog.json composerOptions and are checked by the toolbar to decide
 * which controls to render.
 */
export const OPTION_IDS = {
  /** Reasoning effort level (select: low/medium/high/xhigh/max/ultrathink) */
  EFFORT: 'effort',
  /** Context window size (select: 200k/1M) */
  CONTEXT_WINDOW: 'contextWindow',
  /** Simple thinking toggle for models without granular effort (boolean) */
  THINKING: 'thinking',
  /** Fast mode for models that support it (boolean) */
  FAST_MODE: 'fastMode',
} as const
