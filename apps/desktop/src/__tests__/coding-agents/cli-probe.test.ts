/**
 * Compile-time contract tests for CLI probe service.
 * Verifies exported function signatures match expected contracts.
 */

import { describe, expect, it } from 'vitest'
import type { CLIProbeResult } from '@bitsentry-ce/coding-agents'
import { parseCursorAuthOutput } from '@bitsentry-ce/coding-agents/cli-probe.service'

// Verify probe function signatures at compile time
type ProbeClaudeCodeFn = (binaryPath: string) => Promise<CLIProbeResult>
type ProbeCodexFn = (binaryPath: string, args?: string[]) => Promise<CLIProbeResult>
type DetectBinaryFn = (
  provider: 'claude_code' | 'codex' | 'opencode' | 'cursor',
  preferredBinaryPath?: string,
) => Promise<string | null>
type DoctorFn = (provider: 'claude_code' | 'codex' | 'opencode' | 'cursor', binaryPath: string, codexArgs?: string[]) => Promise<{
  provider: 'claude_code' | 'codex' | 'opencode' | 'cursor'
  binaryPath: string
  probe: CLIProbeResult
  resolvedPath?: string
  stderrTail?: string
}>

// These imports verify the actual exports match the expected signatures
async function _typeCheck() {
  const { probeClaudeCode, probeCodex, probeOpenCode, probeCursor, detectBinary, doctor } = await import('@bitsentry-ce/coding-agents/cli-probe.service')

  // Assign to typed variables — compile error if signatures don't match
  const _pc: ProbeClaudeCodeFn = probeClaudeCode
  const _px: ProbeCodexFn = probeCodex
  const _po: ProbeClaudeCodeFn = probeOpenCode
  const _pcu: ProbeClaudeCodeFn = probeCursor
  const _db: DetectBinaryFn = detectBinary
  const _dr: DoctorFn = doctor

  void [_pc, _px, _po, _pcu, _db, _dr]
}

void _typeCheck

describe('parseCursorAuthOutput', () => {
  it('treats bare unauthenticated text as unauthenticated', () => {
    expect(parseCursorAuthOutput('unauthenticated', '')).toEqual({
      status: 'unauthenticated',
    })
    expect(parseCursorAuthOutput('[error] unauthenticated', '')).toEqual({
      status: 'unauthenticated',
    })
  })

  it('treats logged-in text as authenticated', () => {
    expect(parseCursorAuthOutput('Logged in as wira@example.com', '')).toEqual({
      status: 'authenticated',
    })
  })

  it('treats Cursor about output with no account as unauthenticated', () => {
    expect(parseCursorAuthOutput('User Email          Not logged in', '')).toEqual({
      status: 'unauthenticated',
    })
  })
})
