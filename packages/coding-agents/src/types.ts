export type LocalAiProviderKey = 'claude_code' | 'codex' | 'opencode' | 'cursor'

export type CLIProbeErrorKind =
  | 'not_installed'
  | 'not_executable'
  | 'timed_out'
  | 'unauthenticated'
  | 'incompatible_version'
  | 'app_server_init_failed'
  | 'invalid_response'
  | 'subprocess_exited'

export interface CLIProbeResult {
  installed: boolean
  version: string | null
  auth: { status: 'authenticated' | 'unauthenticated' | 'unknown' }
  status: 'ready' | 'error' | 'warning'
  errorKind?: CLIProbeErrorKind
  message?: string
}

export interface ClaudeCodeSettings {
  enabled: boolean
  binaryPath: string
  lastProbe?: CLIProbeResult
}

export interface CodexSettings {
  enabled: boolean
  binaryPath: string
  codexArgs?: string[]
  lastProbe?: CLIProbeResult
}

export interface OpenCodeSettings {
  enabled: boolean
  binaryPath: string
  opencodeArgs?: string[]
  lastProbe?: CLIProbeResult
}

export interface CursorSettings {
  enabled: boolean
  binaryPath: string
  lastProbe?: CLIProbeResult
}

export interface LocalAiSettings {
  claudeCode: ClaudeCodeSettings
  codex: CodexSettings
  opencode: OpenCodeSettings
  cursor: CursorSettings
}

export const DEFAULT_LOCAL_AI_SETTINGS: LocalAiSettings = {
  claudeCode: {
    enabled: false,
    binaryPath: 'claude',
  },
  codex: {
    enabled: false,
    binaryPath: 'codex',
  },
  opencode: {
    enabled: false,
    binaryPath: 'opencode',
  },
  cursor: {
    enabled: false,
    binaryPath: 'cursor-agent',
  },
}

export type LocalAiStreamDelta =
  | {
      type: 'text' | 'reasoning' | 'tool_start' | 'tool_end' | 'command_output' | 'status'
      text?: string
      toolName?: string
      status?: 'started' | 'completed' | 'failed' | 'cancelled'
    }
  | LocalAiTokenUsageDelta

export interface LocalAiTokenUsage {
  inputTokens: number
  outputTokens: number
  contextTokens?: number
  contextLimit?: number
}

export interface LocalAiExecutionResult {
  output: string
  sessionId?: string
  threadId?: string
  resumeCursor?: unknown
  exitCode?: number
  tokenUsage?: LocalAiTokenUsage
}

export interface LocalAiTokenUsageDelta {
  type: 'token_usage'
  tokenUsage: LocalAiTokenUsage
}
