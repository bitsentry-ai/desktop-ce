import { describe, expect, it } from 'vitest'
import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'
import {
  CLAUDE_HOST_MCP_ALLOWED_TOOLS,
  resolveClaudeAllowedTools,
} from '@bitsentry-ce/coding-agents/claude-code-provider.service'
import {
  chooseCodexApprovalResponse,
  isBitsentryMcpToolItem,
} from '@bitsentry-ce/coding-agents/codex-provider.service'
import {
  CursorToolCallRegistry,
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

    if (accessLevel === 'full-access') {
      expect(allowedTools).toBeUndefined()
      return
    }

    expect(allowedTools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write']))
    for (const hostTool of getHostTools()) {
      expect(allowedTools).toContain(`mcp__${HOST_MCP_SERVER_NAME}__${hostTool.name}`)
    }
    expect(allowedTools).toEqual(expect.arrayContaining(CLAUDE_HOST_MCP_ALLOWED_TOOLS))
  })

  it('passes every host tool through Codex approval handling', () => {
    for (const hostTool of getHostTools()) {
      expect(isBitsentryMcpToolItem({
        type: 'mcpToolCall',
        server: HOST_MCP_SERVER_NAME,
        tool: hostTool.name,
      })).toBe(true)
      expect(chooseCodexApprovalResponse(
        'item/tool/requestUserInput',
        { questions: [{ id: `mcp_tool_call_approval_${hostTool.name}` }] },
        accessLevel,
        true,
      )).toEqual({
        choice: 'allow-host-tool',
        result: {
          answers: {
            [`mcp_tool_call_approval_${hostTool.name}`]: { answers: ['Allow'] },
          },
        },
      })
    }
  })

  it('passes every host tool through Cursor ACP permission handling', () => {
    for (const hostTool of getHostTools()) {
      const toolCallId = `tool_${hostTool.name}`
      const toolCallRegistry = new CursorToolCallRegistry()
      toolCallRegistry.recordSessionUpdate({
        sessionId: 'cursor-session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          name: `mcp__${HOST_MCP_SERVER_NAME}__${hostTool.name}`,
          title: hostTool.name,
          kind: 'other',
          rawInput: {},
        },
      })
      const toolCall = {
        content: [],
        kind: 'other',
        status: 'pending',
        title: 'Cursor MCP call',
        toolCallId,
      }
      expect(isBitsentryHostToolCall(toolCall)).toBe(false)
      expect(chooseCursorPermissionResponse(
        { toolCall, options: permissionOptions },
        accessLevel,
        false,
        toolCallRegistry.get(toolCallId),
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
})
