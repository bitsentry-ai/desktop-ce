// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  it("collapses JSON only when requested and preserves the complete response", () => {
    const content =
      'Evaluation record\n\nPlugin evaluation\n\n```json\n[{"eligibility":"eligible","reviewRequired":true}]\n```\n\n```sh\necho hello\n```';
    const message = makeAgentMessage({
      iterations: [],
      finalText: content,
      status: "done",
    });
    render(
      <TooltipProvider>
        <ChatBubble msg={message} collapsedJsonLabel="Lihat JSON" />
      </TooltipProvider>,
    );
    const summary = screen.getByText("Lihat JSON");
    const disclosure = summary.closest("details")!;
    expect(disclosure.open).toEqual(false);
    expect(screen.getByText("Evaluation record")).toBeTruthy();
    fireEvent.click(summary);
    expect(disclosure.open).toEqual(true);
    expect(disclosure.querySelector("code")?.textContent).toEqual(
      '[{"eligibility":"eligible","reviewRequired":true}]\n',
    );
    expect(screen.getByText("echo hello").closest("details")).toBeNull();
    expect(getCopyableMarkdown(message)).toEqual(content);
    fireEvent.click(summary);
    expect(disclosure.open).toEqual(false);
  });

  it("keeps desktop JSON expanded when the option is absent", () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: '```json\n{"value":1}\n```',
            status: "done",
          })}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('{"value":1}').closest("details")).toBeNull();
  });


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
