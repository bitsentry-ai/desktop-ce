import { describe, expect, it } from 'vitest'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import { resolveClaudeAllowedTools } from '@bitsentry-ce/coding-agents/claude-code-provider.service'
import {
  chooseCodexApprovalResponse,
} from '@bitsentry-ce/coding-agents/codex-provider.service'
import {
  chooseCursorPermissionResponse,
  isBitsentryHostToolCall,
} from '@bitsentry-ce/coding-agents/cursor-provider.service'
import {
  createOpenCodePermissionEnv,
  getOpenCodeHostToolPermissions,
} from '@bitsentry-ce/coding-agents/opencode-provider.service'
import { HOST_MCP_SERVER_NAME } from '@bitsentry-ce/coding-agents/host-mcp-server.service'

const accessLevels = ['auto-accept-edits', 'full-access'] as const
const permissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
]

describe.each(accessLevels)('host tools at %s', (accessLevel) => {
  it('passes every host tool through Claude Code gating', () => {
    const allowedTools = resolveClaudeAllowedTools(accessLevel, true)
    for (const hostTool of getHostTools()) {
      expect(allowedTools).toContain(`mcp__${HOST_MCP_SERVER_NAME}__${hostTool.name}`)
    }
  })

  it('approves the real BitSentry Codex elicitation payload', () => {
    expect(chooseCodexApprovalResponse(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: HOST_MCP_SERVER_NAME,
        mode: 'form',
        message: 'Allow MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          persist: 'session',
          tool_description: 'Creates a governed runbook proposal.',
          tool_params: {},
          tool_params_display: [],
        },
      },
      accessLevel,
    )).toEqual({
      choice: 'allow-host-tool',
      result: {
        action: 'accept',
        content: {},
        _meta: null,
      },
    })
  })

  it('passes every host tool through Cursor ACP permission handling', () => {
    for (const hostTool of getHostTools()) {
      const toolCall = {
        content: [{ type: 'content', content: 'MCP tool request' }],
        kind: 'other',
        status: 'pending',
        title: `${HOST_MCP_SERVER_NAME}-${hostTool.name}: ${hostTool.name}`,
        toolCallId: `tool_${hostTool.name}`,
      }
      expect(isBitsentryHostToolCall(toolCall)).toBe(true)
      expect(chooseCursorPermissionResponse(
        { toolCall, options: permissionOptions },
        accessLevel,
      )).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    }
  })

  it('passes every host tool through OpenCode permission configuration', () => {
    const hostToolPermissions = getOpenCodeHostToolPermissions()
    for (const hostTool of getHostTools()) {
      expect(hostToolPermissions[`${HOST_MCP_SERVER_NAME}_${hostTool.name}`]).toBe('allow')
    }

    const permissionEnv = createOpenCodePermissionEnv(accessLevel)
    if (accessLevel === 'auto-accept-edits') {
      expect(JSON.parse(permissionEnv.OPENCODE_PERMISSION ?? '{}')).toMatchObject({
        bash: 'deny',
        edit: 'allow',
      })
    } else {
      expect(permissionEnv).toEqual({})
    }
  })
})

describe('Codex native approval behavior', () => {
  it('keeps native shell denied at Safe Tools and approves it at All Tools', () => {
    expect(chooseCodexApprovalResponse(
      'item/commandExecution/requestApproval',
      {},
      'auto-accept-edits',
    )).toEqual({ choice: 'deny', result: { decision: 'decline' } })
    expect(chooseCodexApprovalResponse(
      'item/commandExecution/requestApproval',
      {},
      'full-access',
    )).toEqual({ choice: 'allow-full-access', result: { decision: 'acceptForSession' } })
  })

  it('declines non-BitSentry MCP elicitations at Safe Tools', () => {
    expect(chooseCodexApprovalResponse(
      'mcpServer/elicitation/request',
      {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'other-server',
        mode: 'form',
        message: 'Allow MCP call?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: {},
      },
      'auto-accept-edits',
    )).toEqual({ choice: 'deny', result: { action: 'decline', content: null, _meta: null } })
  })
})
