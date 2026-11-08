import { describe, expect, it } from 'vitest'
import { shouldRenderIterationText } from '@bitsentry-ce/components/chat/ChatBubble'
import type { ChatMessage } from '@bitsentry-ce/components/chat/types'
import {
  normalizeMarkdownContent,
  paragraphizePlainTextSoftBreaks,
} from '@bitsentry-ce/components/markdown'

describe('chat markdown formatting', () => {
  it('turns plain streamed lines into paragraphs', () => {
    expect(
      paragraphizePlainTextSoftBreaks(
        [
          'Inspecting the full runbook execution results so I can build the matrix.',
          'Retrieving the full backend log runbook output.',
          'Requesting the full runbook execution output.',
        ].join('\n'),
      ),
    ).toBe(
      [
        'Inspecting the full runbook execution results so I can build the matrix.',
        'Retrieving the full backend log runbook output.',
        'Requesting the full runbook execution output.',
      ].join('\n\n'),
    )
  })

  it('keeps markdown tables structurally intact', () => {
    const table = [
      '| Issue | Status |',
      '|---|---|',
      '| SERVER-287 | Open |',
    ].join('\n')

    expect(paragraphizePlainTextSoftBreaks(table)).toBe(table)
  })

  it('keeps ordinary markdown soft breaks as markdown soft breaks', () => {
    expect(normalizeMarkdownContent('First line\nsecond line')).toBe(
      'First line\nsecond line',
    )
  })

  it('hides pre-final iteration text once an agent message has a final response', () => {
    const message: Extract<ChatMessage, { kind: 'agent' }> = {
      kind: 'agent',
      status: 'done',
      activeIterationId: null,
      finalText: 'Final incident matrix.',
      toolCalls: [],
      iterations: [
        {
          id: 'planning',
          startedAt: '2026-06-01T00:00:00.000Z',
          completedAt: '2026-06-01T00:00:01.000Z',
          text: 'Gathering full runbook execution results.',
          streamDeltas: [],
          toolCallIds: [],
          status: 'done',
        },
        {
          id: 'final',
          startedAt: '2026-06-01T00:00:02.000Z',
          completedAt: '2026-06-01T00:00:03.000Z',
          text: 'Final incident matrix.',
          streamDeltas: [],
          toolCallIds: [],
          status: 'done',
        },
      ],
    }

    expect(shouldRenderIterationText(message, false)).toBe(false)
    expect(shouldRenderIterationText(message, true)).toBe(true)
  })
})
