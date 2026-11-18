// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownContent } from '@bitsentry-ce/components/markdown'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const tableMarkdown = [
  '| Issue | Source | Last Seen | Error Description | Root Cause Analysis |',
  '|---|---|---:|---|---|',
  '| SERVER-287 | Jagad Sentry | 2026-05-30 00:36:33 | Currency lookup failed | Missing or inactive currency record |',
].join('\n')

function sizeScroller(scroller: HTMLElement) {
  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    value: 320,
  })
  Object.defineProperty(scroller, 'scrollWidth', {
    configurable: true,
    value: 960,
  })
}

describe('MarkdownContent table scrolling', () => {
  it('keeps native horizontal table scroll stable across unrelated parent rerenders', () => {
    const renderMarkdown = (tick: number) => (
      <div data-rerender-tick={tick}>
        <MarkdownContent content={tableMarkdown} />
      </div>
    )

    const { rerender } = render(renderMarkdown(0))
    const scroller = screen.getByRole('region', {
      name: 'common.markdown.scrollableTable',
    })
    sizeScroller(scroller)

    scroller.scrollLeft = 180
    fireEvent.scroll(scroller)
    expect(scroller.scrollLeft).toBe(180)

    rerender(renderMarkdown(1))

    const rerenderedScroller = screen.getByRole('region', {
      name: 'common.markdown.scrollableTable',
    })
    sizeScroller(rerenderedScroller)

    expect(rerenderedScroller).toBe(scroller)
    expect(rerenderedScroller.scrollLeft).toBe(180)
  })
})
