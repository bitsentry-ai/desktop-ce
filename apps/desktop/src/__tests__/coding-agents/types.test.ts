/**
 * Compile-time type tests for local-ai module.
 * These verify type compatibility and contract correctness.
 */

import type {
  LocalAiProviderKey,
  CLIProbeResult,
  CLIProbeErrorKind,
  ClaudeCodeSettings,
  CodexSettings,
  OpenCodeSettings,
  CursorSettings,
  LocalAiSettings,
  LocalAiStreamDelta,
  LocalAiExecutionResult,
} from '@bitsentry-ce/coding-agents'
import { DEFAULT_LOCAL_AI_SETTINGS } from '@bitsentry-ce/coding-agents'
import type { RunbookLlmProviderKey } from '@bitsentry-ce/core/features/runbooks/desktop-runbook-ce.types'
import { expect, it } from 'vitest'

// Type assignment tests — these fail at compile time if types are incompatible

// LocalAiProviderKey must be assignable to RunbookLlmProviderKey
const _claudeCode: RunbookLlmProviderKey = 'claude_code' satisfies LocalAiProviderKey
const _codex: RunbookLlmProviderKey = 'codex' satisfies LocalAiProviderKey
const _opencode: RunbookLlmProviderKey = 'opencode' satisfies LocalAiProviderKey
const _cursor: RunbookLlmProviderKey = 'cursor' satisfies LocalAiProviderKey

// CLIProbeErrorKind must include all expected error kinds
const _errorKinds: CLIProbeErrorKind[] = [
  'not_installed',
  'not_executable',
  'timed_out',
  'unauthenticated',
  'incompatible_version',
  'app_server_init_failed',
  'invalid_response',
  'subprocess_exited',
]

// CLIProbeResult must have required fields
const _probeResult: CLIProbeResult = {
  installed: true,
  version: '1.0.0',
  auth: { status: 'authenticated' },
  status: 'ready',
}

// CLIProbeResult with error
const _probeError: CLIProbeResult = {
  installed: false,
  version: null,
  auth: { status: 'unknown' },
  status: 'error',
  errorKind: 'not_installed',
  message: 'CLI not found',
}

// Settings must have correct shape
const _claudeSettings: ClaudeCodeSettings = {
  enabled: true,
  binaryPath: '/usr/local/bin/claude',
}

const _codexSettings: CodexSettings = {
  enabled: true,
  binaryPath: 'codex',
  codexArgs: ['--profile', 'personal'],
}

const _opencodeSettings: OpenCodeSettings = {
  enabled: true,
  binaryPath: 'opencode',
  opencodeArgs: ['--pure'],
}

const _cursorSettings: CursorSettings = {
  enabled: true,
  binaryPath: 'cursor-agent',
}

// Default settings must be valid
const _defaults: LocalAiSettings = DEFAULT_LOCAL_AI_SETTINGS

// Stream delta types
const _textDelta: LocalAiStreamDelta = { type: 'text', text: 'hello' }
const _statusDelta: LocalAiStreamDelta = { type: 'status', status: 'completed' }
const _toolDelta: LocalAiStreamDelta = { type: 'tool_start', toolName: 'bash' }

// Execution result
const _result: LocalAiExecutionResult = {
  output: 'response text',
  sessionId: 'session-123',
  resumeCursor: { sessionId: 'abc', lastMessageUuid: 'def' },
}

it('keeps local AI contracts type-compatible', () => {
  expect([_claudeCode, _codex, _opencode, _cursor, _errorKinds, _probeResult, _probeError, _claudeSettings, _codexSettings, _opencodeSettings, _cursorSettings, _defaults, _textDelta, _statusDelta, _toolDelta, _result]).toHaveLength(16)
})
