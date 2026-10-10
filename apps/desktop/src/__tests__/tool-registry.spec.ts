import { describe, expect, it } from 'vitest'

import {
  getTool,
  getToolNames,
  hasTool,
  validateToolInput,
} from '@bitsentry-ce/core/features/agent-runtime/shared/capability-registry'

describe('agent tool registry', () => {
  it('exposes the allowlisted tool names', () => {
    expect(getToolNames()).toEqual([
      'ssh_journal_query',
      'list_log_sources',
      'get_checkpoint',
      'execute_shell_command',
      'execute_http_request',
    ])
  })

  it('returns tool definitions and existence checks by name', () => {
    expect(hasTool('execute_http_request')).toBe(true)
    expect(hasTool('unknown_tool')).toBe(false)
    expect(getTool('execute_http_request')).toMatchObject({
      name: 'execute_http_request',
    })
    expect(getTool('unknown_tool')).toBeUndefined()
  })

  it('validates known tool input and rejects unknown tools', () => {
    expect(
      validateToolInput('execute_http_request', {
        url: 'https://example.com/api',
      }),
    ).toEqual({
      url: 'https://example.com/api',
      method: 'GET',
    })

    expect(() => validateToolInput('unknown_tool', {})).toThrow(
      'Unknown tool: unknown_tool',
    )
  })
})
