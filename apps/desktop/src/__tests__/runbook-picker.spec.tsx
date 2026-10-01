// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', async () => {
  // Keys are returned as they are, except where a value is interpolated: those use the real en-US text, so a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const english = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/i18n/src/locales/en-US/incidents.json'), 'utf8')) as Record<string, string>
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  return { useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options === undefined ? key : fill(english[key] ?? key, options) }) }
})

import { RunbookPicker } from '@bitsentry-ce/components/investigation/RunbookPicker'

afterEach(cleanup)

const label = (suffix: string) => `incidents.knowledge.picker.${suffix}`
const catalog = [
  { id: 'cmuo4h77f000f01nzg4rj4yxk', title: 'Sandbox: Read-only logon failure telemetry review', revisionNumber: 3 },
  { id: 'cmunzozu6000e01nul0u4sgqn', title: 'Sandbox QA read-only check', revisionNumber: 1 },
  { id: 'cmu5n93lj000801psvmo1psnc', title: 'Read-only CVE Summary Check', revisionNumber: 2 },
  { id: 'cmq5c1s8t000i01o5rusdk3es', title: 'Investigate Errors · Sentry', revisionNumber: 1 },
]
const LONG_TITLE = 'Diagnosis · Bitsentry Telemetry Verification Summary for every Debian host behind the staging load balancer'

type Props = Partial<Parameters<typeof RunbookPicker>[0]>
function Host({ initial = null, ...props }: Props & { initial?: string | null }) {
  const [selectedId, setSelectedId] = useState<string | null>(initial)
  return <>
    <RunbookPicker runbooks={catalog} loading={false} loadFailed={false} disabled={false} {...props} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); props.onSelect?.(id) }} />
    <button type="button">Next control</button>
  </>
}
const trigger = () => screen.getByRole('button', { name: new RegExp(`${label('placeholder')}|Revision`) })
const search = () => screen.getByRole('combobox', { name: label('searchLabel') })
const rows = () => screen.queryAllByRole('option')
const titles = () => rows().map((row) => row.querySelector('[title]')?.getAttribute('title'))

describe('the closed picker', () => {
  it('tells the engineer what to do and that choosing does not run anything', () => {
    render(<Host />)

    expect(trigger().textContent).toContain(label('placeholder'))
    expect(trigger().textContent).toContain(label('hint'))
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('names the selected runbook with its revision as context', () => {
    render(<Host initial={catalog[0]!.id} />)

    expect(trigger().textContent).toContain(catalog[0]!.title)
    expect(trigger().textContent).toContain('Revision 3')
    expect(trigger().textContent).not.toContain(label('placeholder'))
  })

  it('cannot be opened while disabled', async () => {
    render(<Host disabled />)

    await userEvent.setup().click(trigger())

    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('the open picker', () => {
  it('shows a labelled search field and one row per saved runbook, title first', async () => {
    render(<Host />)
    await userEvent.setup().click(trigger())

    expect(document.activeElement).toBe(search())
    expect(titles()).toEqual(catalog.map((row) => row.title))
    const first = within(rows()[0]!)
    expect(first.getByText('Revision 3')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('4 of 4 runbooks')
  })

  it('cuts a long ID for scanning but still gives the full ID to the tooltip and to screen readers', async () => {
    render(<Host />)
    await userEvent.setup().click(trigger())

    const row = rows()[0]!
    expect(within(row).getByText('ID cmuo4h77…').getAttribute('title')).toBe(catalog[0]!.id)
    expect(row.textContent).toContain(`ID ${catalog[0]!.id}`)
  })

  it('keeps a very long title readable in full through its tooltip and accessible name', async () => {
    render(<Host runbooks={[{ id: 'rb-long', title: LONG_TITLE, revisionNumber: 7 }]} />)
    await userEvent.setup().click(trigger())

    const row = screen.getByRole('option', { name: new RegExp(LONG_TITLE) })
    expect(row.querySelector('[title]')?.getAttribute('title')).toBe(LONG_TITLE)
  })

  it('narrows the list as the engineer types, matching titles before IDs', async () => {
    render(<Host />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.type(search(), '  READ-only ')
    expect(titles()).toEqual(['Sandbox: Read-only logon failure telemetry review', 'Sandbox QA read-only check', 'Read-only CVE Summary Check'])
    expect(screen.getByRole('status').textContent).toBe('3 of 4 runbooks')

    await user.clear(search())
    await user.type(search(), 'cmq5c1')
    expect(titles()).toEqual(['Investigate Errors · Sentry'])
  })

  it('says so when nothing matches', async () => {
    render(<Host />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.type(search(), 'zzz')

    expect(rows()).toEqual([])
    expect(screen.getByText('No runbook matches “zzz”.')).toBeTruthy()
  })

  it('says so while loading and when there are no saved runbooks', async () => {
    const user = userEvent.setup()
    const view = render(<Host runbooks={[]} loading />)
    await user.click(trigger())
    expect(screen.getByText(label('loading'))).toBeTruthy()
    expect(screen.queryByText(label('empty'))).toBeNull()

    view.rerender(<Host runbooks={[]} loading={false} />)
    expect(screen.getByText(label('empty'))).toBeTruthy()
  })

  it('does not call an unavailable catalog empty when it could not be loaded', async () => {
    render(<Host runbooks={[]} loading={false} loadFailed />)
    await userEvent.setup().click(trigger())

    expect(screen.queryByText(label('empty'))).toBeNull()
  })

  it('marks the current runbook as selected', async () => {
    render(<Host initial={catalog[2]!.id} />)
    await userEvent.setup().click(trigger())

    expect(rows().map((row) => row.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false'])
  })
})

describe('choosing a runbook', () => {
  it('selects with the mouse, closes the list and shows the choice on the trigger', async () => {
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.click(screen.getByRole('option', { name: /Read-only CVE Summary Check/ }))

    expect(onSelect).toHaveBeenCalledWith(catalog[2]!.id)
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(trigger().textContent).toContain('Read-only CVE Summary Check')
    expect(document.activeElement).toBe(trigger())
  })

  it('selects with the keyboard: arrows move, Enter chooses the highlighted row', async () => {
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.keyboard('{ArrowDown}{ArrowDown}')
    expect(search().getAttribute('aria-activedescendant')).toBe(rows()[2]!.id)
    await user.keyboard('{Enter}')

    expect(onSelect).toHaveBeenCalledWith(catalog[2]!.id)
    expect(document.activeElement).toBe(trigger())
  })

  it('chooses the first match after searching', async () => {
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.type(search(), 'sentry{Enter}')

    expect(onSelect).toHaveBeenCalledWith('cmq5c1s8t000i01o5rusdk3es')
  })

  it('closes with Escape without choosing, and returns focus to the trigger', async () => {
    const onSelect = vi.fn()
    render(<Host onSelect={onSelect} />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes when focus moves on to the next control', async () => {
    render(<Host />)
    const user = userEvent.setup()
    await user.click(trigger())

    await user.tab()

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next control' }))
  })

  it('starts from the current choice when it is opened again', async () => {
    render(<Host initial={catalog[1]!.id} />)
    const user = userEvent.setup()
    await user.click(trigger())

    expect(search().getAttribute('aria-activedescendant')).toBe(rows()[1]!.id)
    expect((search() as HTMLInputElement).value).toBe('')
  })
})
