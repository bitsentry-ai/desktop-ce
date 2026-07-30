/**
 * Agent Runtime Types
 *
 * Main-process agentic tool execution with structured tool calling.
 * All tool execution happens in main process only - renderer never executes directly.
 */

/**
 * Agent session state tracked in-memory (no persisted secrets).
 */
export type AgentSessionState = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * Tool execution lifecycle state.
 */
export type ToolExecutionState = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/**
 * Agent event types streamed to renderer.
 */
export type AgentEventType =
  | 'assistant_delta'  // Streaming assistant response chunks
  | 'token_usage'      // Live token/context usage update
  | 'thinking_start'   // AI started reasoning (before LLM call)
  | 'thinking_delta'   // Streaming thinking content
  | 'thinking_end'     // AI finished reasoning
  | 'tool_start'       // Tool execution started
  | 'tool_update'      // Tool output update (streaming)
  | 'tool_end'         // Tool execution ended (success or failure)
  | 'final'            // Final assistant response complete
  | 'cancelled'        // Session cancelled by user or timeout
  | 'error'            // Agent-level error

export type AgentErrorCode = 'NO_LLM_PROVIDER_CONFIGURED'

/**
 * Base agent event structure.
 */
export interface AgentEvent {
  type: AgentEventType
  timestamp: string
}

/**
 * Streaming assistant delta (text chunks).
 */
export interface AssistantDeltaEvent extends AgentEvent {
  type: 'assistant_delta'
  delta: string
  kind?: 'text' | 'command_output'
}

export interface TokenUsageEvent extends AgentEvent {
  type: 'token_usage'
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    contextTokens?: number
    contextLimit?: number
  }
}

/**
 * AI started reasoning (before LLM call).
 */
export interface ThinkingStartEvent extends AgentEvent {
  type: 'thinking_start'
}

/**
 * Streaming thinking content (optional detailed reasoning).
 */
export interface ThinkingDeltaEvent extends AgentEvent {
  type: 'thinking_delta'
  delta: string
}

/**
 * AI finished reasoning.
 */
export interface ThinkingEndEvent extends AgentEvent {
  type: 'thinking_end'
}

export interface AgentChatAttachment {
  id: string
  type: 'image'
  name: string
  mimeType: string
  sizeBytes: number
  dataUrl: string
}

export type AgentProviderKey = 'groq' | 'kilocode' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'claude_code' | 'codex' | 'opencode' | 'cursor'

export interface AgentLlmSelection {
  providerKey?: AgentProviderKey
  model?: string
  thinkingEnabled?: boolean
}

export interface ToolCallCard {
  toolCallId: string
  toolName: string
  state: 'running' | 'done' | 'failed'
  error?: string
  input?: Record<string, unknown>
  output?: string
  modelContext?: string
}

export interface StreamDeltaRecord {
  timestamp: string
  text: string
  kind?: 'text' | 'command_output'
}

export interface AgentThreadTokenUsage {
  inputTokens: number
  outputTokens: number
  contextTokens?: number
  contextLimit?: number
}

export interface AgentIteration {
  id: string
  startedAt: string
  completedAt?: string
  text: string
  streamDeltas?: StreamDeltaRecord[]
  toolCallIds: string[]
  status: 'thinking' | 'streaming' | 'done' | 'error'
}

export type ChatMessage =
  | {
      kind: 'user'
      text: string
      attachments?: AgentChatAttachment[]
    }
  | {
      kind: 'agent'
      iterations: AgentIteration[]
      activeIterationId: string | null
      toolCalls: ToolCallCard[]
      finalText: string | null
      status: 'thinking' | 'streaming' | 'done' | 'error' | 'cancelled'
      errorMsg?: string
      errorCode?: AgentErrorCode
    }

export interface AgentThreadSnapshot {
  sessionId: string
  startedAt: string
  runtimeState: AgentSessionState
  threadState: AgentSessionState
  currentToolCallId: string | null
  messages: ChatMessage[]
  tokenUsage?: AgentThreadTokenUsage
}

/**
 * Tool execution started.
 */
export interface ToolStartEvent extends AgentEvent {
  type: 'tool_start'
  toolName: string
  toolCallId: string
  input: Record<string, unknown>
}

/**
 * Tool output update (for streaming tools).
 */
export interface ToolUpdateEvent extends AgentEvent {
  type: 'tool_update'
  toolCallId: string
  chunk: string
  truncationWarning?: boolean  // Set if output was truncated for context safety
}

/**
 * Tool execution ended.
 */
export interface ToolEndEvent extends AgentEvent {
  type: 'tool_end'
  toolCallId: string
  state: ToolExecutionState
  output?: string              // Truncated if large
  modelContext?: string        // Exact tool message appended back to the LLM
  artifactId?: string          // Reference to full output if truncated
  error?: string               // Error message if failed
}

/**
 * Final assistant response (complete).
 */
export interface FinalEvent extends AgentEvent {
  type: 'final'
  response: string
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    contextTokens?: number
    contextLimit?: number
  }
}

/**
 * Session cancelled by user or timeout.
 */
export interface CancelledEvent extends AgentEvent {
  type: 'cancelled'
  message: string
}

/**
 * Agent-level error.
 */
export interface AgentErrorEvent extends AgentEvent {
  type: 'error'
  message: string
  code?: AgentErrorCode
  level?: 'error' | 'warning'
}

/**
 * Union type of all agent events.
 */
export type AgentEventData =
  | AssistantDeltaEvent
  | TokenUsageEvent
  | ThinkingStartEvent
  | ThinkingDeltaEvent
  | ThinkingEndEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | FinalEvent
  | CancelledEvent
  | AgentErrorEvent

/**
 * Agent start request.
 */
export interface AgentStartInput {
  prompt: string
  timeoutMs?: number  // Default: 300000 (5 minutes) for thinking models
  attachments?: AgentChatAttachment[]
  llm?: AgentLlmSelection
  accessLevel?: 'supervised' | 'auto-accept-edits' | 'full-access'
  traitValues?: Record<string, string | boolean>
  runbookContext?: RunbookContext  // Optional: Active runbook for contextualized responses
  incidentThreadId?: string
}

/**
 * Agent send request (continue conversation).
 */
export interface AgentSendInput {
  message: string
  sessionId?: string  // Optional: continue existing session
  attachments?: AgentChatAttachment[]
  llm?: AgentLlmSelection
  accessLevel?: 'supervised' | 'auto-accept-edits' | 'full-access'
  traitValues?: Record<string, string | boolean>
  runbookContext?: RunbookContext  // Optional: runbook for session recovery
  incidentThreadId?: string
}

/**
 * Agent session snapshot.
 */
export interface AgentSessionStatus {
  sessionId: string
  state: AgentSessionState
  startedAt: string
  currentToolCallId: string | null
}

/**
 * Tool definition registry.
 */
export interface ToolDefinition<TInput = unknown> {
  name: string
  description: string
  inputSchema: {
    parse: (input: unknown) => TInput
    safeParse: (input: unknown) => { success: true; data: TInput } | { success: false; error: Error }
  }
  execute: (input: TInput, context: ToolContext) => Promise<ToolResult>
}

/**
 * Tool execution context (passed to each tool).
 */
export interface ToolContext {
  sessionId: string
  toolCallId: string
  signal: AbortSignal
  onChunk: (chunk: string) => void  // For streaming output
}

/**
 * Tool execution result.
 */
export interface ToolResult {
  output?: string
  artifactId?: string  // Reference to stored full output if too large
  error?: string
}

/**
 * Runbook action types (mirrors renderer RunbookAction).
 */
export type RunbookActionType =
  | 'shell'
  | 'llm'
  | 'http'
  | 'external_source'
  | 'data_source_query'
  | 'telemetry_ingest'
  | 'diagnosis_diagnose'
  | 'diagnosis_verify'
  | 'diagnosis_recommend'

/**
 * Runbook action (mirrors renderer RunbookAction).
 */
export interface RunbookAction {
  id: string
  type: RunbookActionType
  title: string
  command?: string
  prompt?: string
  llmProviderKey?: string
  llmModel?: string
  url?: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: string
  body?: string
  parameters?: Array<{
    id: string
    key: string
    label?: string
    description?: string
    defaultValue?: string
    required?: boolean
  }>
}

/**
 * Runbook context for system prompt generation.
 */
export interface RunbookContext {
  id: string
  title: string
  description: string
  actions: RunbookAction[]
}

/**
 * Allowlisted journalctl priorities.
 */
export const JOURNALCTL_PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'] as const
export type JournalctlPriority = (typeof JOURNALCTL_PRIORITIES)[number]

/**
 * SSH journal query tool input (strictly typed).
 */
export interface SshJournalQueryInput {
  sourceId?: string  // Future: reference to saved source
  host: string
  username: string
  port?: number
  since: string
  until?: string
  cursor?: string
  units?: string[]   // e.g., ['nginx.service', 'ssh.service']
  priorities?: JournalctlPriority[]
  limit?: number     // Max lines (default: 1000)
  follow?: boolean   // Follow mode (-f)
}

/**
 * Command builder result (shared between manual UI and tool path).
 */
export interface SshJournalctlCommand {
  args: string[]
  display: string    // Safe-for-display command string
}

/**
 * Error classification from stderr (shared between manual UI and tool path).
 */
export interface ErrorClassification {
  message: string
  level: 'error' | 'warning'
}
