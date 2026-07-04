import { describe, expect, it } from 'vitest'
import {
  chooseCursorPermissionResponse,
  cursorDeltasFromSessionUpdate,
  extractCursorModelIds,
} from '@bitsentry-ce/coding-agents/cursor-provider.service'

const permissionOptions = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
]

describe('Cursor provider behavior', () => {
  it('chooses ACP permission options from access level and tool kind', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'read-1', kind: 'read', title: 'Read file' },
          options: permissionOptions,
        },
        'supervised',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'supervised',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'auto-accept-edits',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: permissionOptions,
        },
        'auto-accept-edits',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } })

    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: permissionOptions,
        },
        'full-access',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('keeps automatic full-access approvals scoped to a single Cursor request', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'bash-1', kind: 'execute', title: 'Run shell command' },
          options: [
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          ],
        },
        'full-access',
      ),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('cancels pending permission requests during abort', () => {
    expect(
      chooseCursorPermissionResponse(
        {
          toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Edit file' },
          options: permissionOptions,
        },
        'full-access',
        true,
      ),
    ).toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('translates session/update notifications into local stream deltas', () => {
    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      }),
    ).toEqual([{ type: 'text', text: 'hello' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'thinking' },
        },
      }),
    ).toEqual([{ type: 'reasoning', text: 'thinking' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-1',
          kind: 'execute',
          title: 'Run tests',
          status: 'in_progress',
        },
      }),
    ).toEqual([{ type: 'tool_start', toolName: 'Run tests', status: 'started' }])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Run tests',
          status: 'completed',
          content: [{ type: 'text', text: 'done' }],
        },
      }),
    ).toEqual([
      { type: 'command_output', toolName: 'Run tests', text: 'done' },
      { type: 'tool_end', toolName: 'Run tests', status: 'completed' },
    ])

    expect(
      cursorDeltasFromSessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          title: 'Read file',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'nested output' },
            },
          ],
        },
      }),
    ).toEqual([
      { type: 'command_output', toolName: 'Read file', text: 'nested output' },
    ])
  })

  it('extracts Cursor models from ACP session state and config options', () => {
    expect(
      extractCursorModelIds({
        sessionId: 'session-1',
        models: {
          currentModelId: 'claude-opus-4-6',
          availableModels: [
            { modelId: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { modelId: 'gpt-5', name: 'GPT-5' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            type: 'select',
            category: 'model',
            currentValue: 'claude-opus-4-6',
            name: 'Model',
            options: [
              { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
              {
                name: 'OpenAI',
                options: [{ value: 'gpt-5.4', name: 'GPT-5.4' }],
              },
            ],
          },
        ],
      }),
    ).toEqual(['claude-opus-4-6', 'gpt-5', 'claude-sonnet-4-6', 'gpt-5.4'])
  })

})
