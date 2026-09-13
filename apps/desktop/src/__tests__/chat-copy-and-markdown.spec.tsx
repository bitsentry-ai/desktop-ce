// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChatBubble, getCopyableMarkdown } from '@bitsentry-ce/components/chat/ChatBubble'
import type { ChatMessage } from '@bitsentry-ce/components/chat/types'
import { getCodeText, normalizeMarkdownContent } from '@bitsentry-ce/components/markdown'
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

  it('keeps inline code pipes inside one markdown table cell', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '| Check | Result |',
              '| --- | --- |',
              '| `check || true` | Passed |',
              '',
              '```sh',
              '| fenced || true |',
              '```',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toEqual('check || true')
    expect(cells[1].textContent).toEqual('Passed')
    expect(screen.getByText('| fenced || true |')).toBeTruthy()
  })

  it('keeps code pipes in tables without outer pipes', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              'Command | Result',
              '--- | ---',
              '`check || true` | Passed',
              '`path\\` | Preserved',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const rows = screen.getAllByRole('row')
    const commandCells = within(rows[1]).getAllByRole('cell')
    const pathCells = within(rows[2]).getAllByRole('cell')
    expect(commandCells).toHaveLength(2)
    expect(commandCells[0].textContent).toEqual('check || true')
    expect(commandCells[1].textContent).toEqual('Passed')
    expect(pathCells).toHaveLength(2)
    expect(pathCells[0].textContent).toEqual('path\\')
    expect(pathCells[1].textContent).toEqual('Preserved')
  })

  it('does not rewrite pipe-shaped prose or indented code', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: ['| use `a|b` |', '', '    | `c|d` |'].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    expect(screen.getByText('a|b').textContent).toEqual('a|b')
    expect(screen.getByText('| `c|d` |').textContent).toEqual('| `c|d` |\n')
  })

  it('keeps table-like text inside valid fenced code blocks', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '~~~text',
              '~~~not-a-close',
              '| `a|b` |',
              '~~~',
              '',
              '- ```text',
              '  | `c|d` |',
              '  ```',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    expect(screen.getByText(/~~~not-a-close/).textContent).toContain('| `a|b` |')
    expect(screen.getByText('| `c|d` |').textContent).toEqual('| `c|d` |\n')
  })

  it('does not treat invalid backtick fences as code blocks', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '``` aa ```',
              '',
              '| Command | Result |',
              '| --- | --- |',
              '| `check || true` | Passed |',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toEqual('check || true')
    expect(cells[1].textContent).toEqual('Passed')
  })

  it('closes list-nested fences at their content indentation', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '-   ```text',
              '    | `a|b` |',
              '    ```',
              '',
              '| Command | Result |',
              '| --- | --- |',
              '| `check || true` | Passed |',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toEqual('check || true')
    expect(cells[1].textContent).toEqual('Passed')
  })

  it('keeps inline code pipes inside a quoted markdown table cell', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '> Command | Result',
              '> --- | ---',
              '> `check || true` | Passed',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toEqual('check || true')
    expect(cells[1].textContent).toEqual('Passed')
  })

  it('recognizes table headers with only inline-code pipes', () => {
    const content = ['`Name|Kind`', '--- | ---', '`value|kind` | stable'].join('\n')

    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: content,
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell')
    expect(cells).toHaveLength(2)
    expect(cells[0].textContent).toEqual('value|kind')
    expect(cells[1].textContent).toEqual('stable')
  })

  it('protects fenced code nested in blockquotes', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '> ```text',
              '> | `a|b` |',
              '> ```',
              '',
              '| Command | Result |',
              '| --- | --- |',
              '| `check || true` | Passed |',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    expect(screen.getByText('| `a|b` |').textContent).toContain('| `a|b` |')
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('protects tab-indented code blocks', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: ['\t| `a|b` |', '\t--- | ---', '\t| `c|d` |'].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    expect(screen.queryAllByRole('row')).toHaveLength(0)
    expect(screen.getByText(/\| `c\|d` \|/).textContent).toContain('| `c|d` |')
  })

  it('stops a table before a following blockquote', () => {
    render(
      <TooltipProvider>
        <ChatBubble
          msg={makeAgentMessage({
            iterations: [],
            finalText: [
              '| Command | Result |',
              '| --- | --- |',
              '| `ok|v` | Passed |',
              '> `x|y` | text',
            ].join('\n'),
            status: 'done',
          })}
        />
      </TooltipProvider>,
    )

    expect(screen.getAllByRole('row')).toHaveLength(2)
    expect(screen.getByText('x|y').textContent).toEqual('x|y')
  })

  it('does not normalize tables with mismatched header columns', () => {
    const content = [
      '| A | B | C |',
      '| --- | --- |',
      '| `x|y` | z |',
    ].join('\n')

    expect(normalizeMarkdownContent(content)).toEqual(content)
  })

  it('does not enter an unmatched inline-code span', () => {
    const content = [
      '| Command | Result |',
      '| --- | --- |',
      '| `unclosed | Passed |',
    ].join('\n')

    expect(normalizeMarkdownContent(content)).toEqual(content)
  })

  it('preserves already escaped pipes inside inline code', () => {
    const content = ['| Command | Result |', '| --- | --- |', '| `a\\|b` | Passed |'].join('\n')

    expect(normalizeMarkdownContent(content)).toEqual(content)
  })

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
