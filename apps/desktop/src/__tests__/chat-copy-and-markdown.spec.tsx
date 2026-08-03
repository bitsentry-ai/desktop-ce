// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatBubble, getCopyableMarkdown } from '@bitsentry-ce/components/chat/ChatBubble'
import type { ChatMessage } from '@bitsentry-ce/components/chat/types'
import { getCodeText } from '@bitsentry-ce/components/markdown'
import { TooltipProvider } from '@bitsentry-ce/components/ui/tooltip'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

afterEach(() => {
  cleanup()
})

function makeAgentMessage(overrides: Partial<Extract<ChatMessage, { kind: 'agent' }>> = {}) {
  return {
    kind: 'agent' as const,
    iterations: [
      {
        id: 'iteration-1',
        startedAt: '2026-07-29T00:00:00.000Z',
        completedAt: '2026-07-29T00:00:01.000Z',
        text: 'First complete paragraph.',
        toolCallIds: [],
        status: 'done' as const,
      },
      {
        id: 'iteration-2',
        startedAt: '2026-07-29T00:00:02.000Z',
        completedAt: '2026-07-29T00:00:03.000Z',
        text: 'Second complete paragraph.',
        toolCallIds: [],
        status: 'done' as const,
      },
    ],
    activeIterationId: null,
    toolCalls: [],
    finalText: null,
    status: 'streaming' as const,
    ...overrides,
  }
}

describe('incident response copy and markdown extraction', () => {
  it('copies the same complete multi-iteration content rendered in the chat', () => {
    const message = makeAgentMessage()

    expect(getCopyableMarkdown(message)).toBe(
      'First complete paragraph.\n\nSecond complete paragraph.',
    )
  })

  it('renders the copy action below the response in a left-aligned row', () => {
    const message = makeAgentMessage()

    render(
      <TooltipProvider>
        <ChatBubble msg={message} providerKey="openai" />
      </TooltipProvider>,
    )

    const response = screen.getByText('First complete paragraph.')
    const copyButton = screen.getByRole('button', {
      name: 'common.markdown.copyResponseMarkdown',
    })

    expect(
      response.compareDocumentPosition(copyButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(copyButton.parentElement?.className).toContain('flex items-center gap-1.5')
  })

  it('extracts nested code-block text recursively', () => {
    const code = createElement(
      'code',
      null,
      'const ',
      createElement('span', null, 'value', createElement('strong', null, ' = 1')),
      42,
    )
    const pre = createElement('pre', null, code)

    expect(getCodeText(pre.props.children)).toBe('const value = 1' + '42')
  })
})
