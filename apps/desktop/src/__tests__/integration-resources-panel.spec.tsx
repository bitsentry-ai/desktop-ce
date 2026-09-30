// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IntegrationResource } from '@bitsentry-ce/core/features/plugins'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', async () => {
  // Keys are returned as they are, except where a value is interpolated: those use the real en-US text, so a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const english = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/i18n/src/locales/en-US/incidents.json'), 'utf8')) as Record<string, string>
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  return { useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options === undefined ? key : fill(english[key] ?? key, options) }) }
})

import { IntegrationResourcesPanel, type IntegrationResourcesPort } from '@bitsentry-ce/components/investigation/IntegrationResourcesPanel'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'
import type { BitsentryServicePorts } from '@bitsentry-ce/components/services/contracts'

afterEach(cleanup)

const label = (suffix: string) => `incidents.integrationResources.${suffix}`
const connectionId = '11111111-1111-4111-8111-111111111111'
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

function ticket(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: 'thread-1', connectionId, connectionName: 'Itop Bitsentry', resourceType: 'ticket', externalId: '3',
    url: 'https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=3',
    title: 'Logon Failure - Unknown user or bad password',
    state: { ref: 'R-000003', status: 'resolved', className: 'UserRequest', team_id: 39, agent_id: 14, request_type: 'incident' },
    observedAt: minutesAgo(5), ...overrides,
  }
}
function document_(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: 'thread-1', connectionId, connectionName: 'Team wiki', resourceType: 'document', externalId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    url: 'https://outline.example/doc/sandbox-integration-read-example', title: 'Sandbox integration read example',
    state: { updatedAt: '2026-09-29T09:00:00.000Z', publishedAt: '2026-09-28T09:00:00.000Z', collectionId: 'collection-0001-long' },
    observedAt: minutesAgo(60), ...overrides,
  }
}

function renderPanel(rows: IntegrationResource[], options: { disabled?: boolean; select?: IntegrationResourcesPort['select'] | null } = {}) {
  const select = options.select === null ? undefined : options.select ?? vi.fn(async () => undefined)
  const service: IntegrationResourcesPort = { list: vi.fn(async () => rows), ...(select === undefined ? {} : { select }) }
  const view = render(
    <BitsentryServicesProvider services={{ runbooks: { list: async () => [], getExecution: async () => null, execute: async () => ({}) } } as unknown as BitsentryServicePorts}>
      <IntegrationResourcesPanel threadId="thread-1" disabled={options.disabled ?? false} service={service} />
    </BitsentryServicesProvider>,
  )
  return { ...view, service, select }
}
const header = () => screen.findByRole('button', { name: new RegExp(label('title')) })
async function open() {
  fireEvent.click(await header())
}

describe('linked resources panel header', () => {
  it('is collapsed by default, shows how many resources and sources there are, and toggles with aria-expanded', async () => {
    renderPanel([ticket({ selected: true }), document_()])
    const button = await header()

    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(within(button).getByText('2')).toBeTruthy()
    expect(within(button).getByText('1 selected as sources')).toBeTruthy()
    expect(screen.getByLabelText(label('title'), { selector: 'section' })).toBeTruthy()
    expect(document.getElementById(button.getAttribute('aria-controls')!)?.hidden).toBe(true)

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(button.getAttribute('aria-controls')!)?.hidden).toBe(false)

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('does not say anything about selected sources when none is selected', async () => {
    renderPanel([ticket()])
    const button = await header()

    expect(within(button).queryByText(/selected as sources/)).toBeNull()
    expect(button.textContent).not.toContain('{{')
  })

  it('renders nothing when there is nothing linked and nothing failed', async () => {
    const { container } = renderPanel([])
    await Promise.resolve()

    expect(container.querySelector('section')).toBeNull()
  })
})

describe('a linked ticket card', () => {
  it('shows the title, the reference with its class and id, the connection and the status', async () => {
    const { container } = renderPanel([ticket()])
    await open()

    const card = screen.getByRole('article', { name: 'Logon Failure - Unknown user or bad password' })
    expect(within(card).getByRole('heading', { level: 4 }).textContent).toBe('Logon Failure - Unknown user or bad password')
    expect(within(card).getByText('R-000003 · UserRequest #3')).toBeTruthy()
    expect(within(card).getByText('Itop Bitsentry')).toBeTruthy()
    expect(within(card).getByText('resolved')).toBeTruthy()
    // No raw state and no class name on its own: this is a card, not debug output.
    expect(container.querySelector('pre')).toBeNull()
    expect(within(card).queryByText('className')).toBeNull()
    expect(card.textContent).not.toContain('{')
  })

  it('shows team, agent and request type, and leaves out zero and empty values', async () => {
    renderPanel([
      ticket(),
      ticket({ externalId: '4', title: 'Unassigned request', state: { ref: 'R-000004', status: 'new', className: 'UserRequest', team_id: 0, agent_id: '', request_type: 'incident' } }),
    ])
    await open()

    const assigned = screen.getByRole('article', { name: 'Logon Failure - Unknown user or bad password' })
    expect(within(assigned).getByText(label('team')).nextElementSibling?.textContent).toBe('39')
    expect(within(assigned).getByText(label('agent')).nextElementSibling?.textContent).toBe('14')
    expect(within(assigned).getByText(label('requestType')).nextElementSibling?.textContent).toBe('incident')

    const unassigned = screen.getByRole('article', { name: 'Unassigned request' })
    expect(within(unassigned).queryByText(label('team'))).toBeNull()
    expect(within(unassigned).queryByText(label('agent'))).toBeNull()
    expect(within(unassigned).getByText(label('requestType'))).toBeTruthy()
  })

  it('falls back to the class and id when the state carries no reference', async () => {
    renderPanel([ticket({ state: { className: 'Problem' }, externalId: '7' })])
    await open()

    expect(screen.getByText('Problem #7')).toBeTruthy()
  })

  it('maps the status to a badge: solved, new and in-progress look different from each other', async () => {
    renderPanel([
      ticket({ externalId: '1', title: 'Solved one', state: { status: 'resolved' } }),
      ticket({ externalId: '2', title: 'Closed one', state: { status: 'closed' } }),
      ticket({ externalId: '3', title: 'New one', state: { status: 'new' } }),
      ticket({ externalId: '4', title: 'Assigned one', state: { status: 'assigned' } }),
      ticket({ externalId: '5', title: 'Odd one', state: { status: 'on_hold' } }),
    ])
    await open()
    const badge = (title: string, text: string) => within(screen.getByRole('article', { name: title })).getByText(text)

    expect(badge('Solved one', 'resolved').className).toContain('emerald')
    expect(badge('Closed one', 'closed').className).toContain('emerald')
    expect(badge('Assigned one', 'assigned').className).toContain('amber')
    expect(badge('New one', 'new').className).not.toContain('emerald')
    expect(badge('New one', 'new').className).not.toContain('amber')
    expect(badge('Odd one', 'on hold').className).toContain('bg-muted')
  })

  it('links to the source in a new tab with an accessible name', async () => {
    renderPanel([ticket()])
    await open()

    const link = screen.getByRole('link', { name: label('openInTicketSystem') })
    expect(link.getAttribute('href')).toBe('https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=3')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('says when it was observed, with the exact time available', async () => {
    const observedAt = minutesAgo(5)
    renderPanel([ticket({ observedAt })])
    await open()

    const time = screen.getByText(/^Observed /)
    expect(time.tagName).toBe('TIME')
    expect(time.getAttribute('dateTime')).toBe(observedAt)
    expect(time.getAttribute('title')).toBe(new Date(observedAt).toLocaleString())
  })
})

describe('a linked document card', () => {
  it('shows the title, a short id, the update date, the collection and that it is published', async () => {
    const { container } = renderPanel([document_()])
    await open()

    const card = screen.getByRole('article', { name: 'Sandbox integration read example' })
    expect(within(card).getByText('a1b2c3d4')).toBeTruthy()
    expect(within(card).getByText(label('published'))).toBeTruthy()
    expect(within(card).getByText(label('updated')).nextElementSibling?.textContent).toBe(new Date('2026-09-29T09:00:00.000Z').toLocaleDateString())
    expect(within(card).getByText(label('collection')).nextElementSibling?.textContent).toBe('collecti')
    expect(within(card).getByRole('link', { name: label('openInKnowledgeBase') })).toBeTruthy()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('shows a draft when it was never published', async () => {
    renderPanel([document_({ state: { updatedAt: '2026-09-29T09:00:00.000Z' } })])
    await open()

    expect(screen.getByText(label('draft'))).toBeTruthy()
    expect(screen.queryByText(label('published'))).toBeNull()
  })
})

describe('using a resource as a source', () => {
  it('offers a pressed-state toggle that selects and deselects through the service', async () => {
    const { select } = renderPanel([ticket()])
    await open()

    const off = screen.getByRole('button', { name: label('useAsSource') })
    expect(off.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(off)
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ externalId: '3', connectionId }), true)
  })

  it('shows a selected card as selected and toggles it off', async () => {
    const { select } = renderPanel([ticket({ selected: true })])
    await open()

    const card = screen.getByRole('article', { name: 'Logon Failure - Unknown user or bad password' })
    expect(card.className).toContain('ring-primary')
    const on = within(card).getByRole('button', { name: label('sourceSelected') })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ externalId: '3' }), false)
  })

  it('leaves an unselected card without the selection ring', async () => {
    renderPanel([ticket()])
    await open()

    expect(screen.getByRole('article').className).not.toContain('ring-primary')
  })

  it('cannot be toggled in an archived conversation', async () => {
    const { select } = renderPanel([ticket()], { disabled: true })
    await open()

    const toggle = screen.getByRole('button', { name: label('useAsSource') }) as HTMLButtonElement
    expect(toggle.disabled).toBe(true)
    fireEvent.click(toggle)
    expect(select).not.toHaveBeenCalled()
  })

  it('shows no toggle when the product cannot select sources', async () => {
    renderPanel([ticket()], { select: null })
    await open()

    expect(screen.queryByRole('button', { name: label('useAsSource') })).toBeNull()
    expect(screen.getByRole('article')).toBeTruthy()
  })
})

describe('keyboard use', () => {
  it('reaches the header, then each card’s link and toggle, in reading order', async () => {
    renderPanel([ticket(), document_()])
    const user = userEvent.setup()
    await open()
    ;(await header()).focus()

    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('link', { name: label('openInTicketSystem') }))
    await user.tab()
    expect(document.activeElement?.textContent).toBe(label('useAsSource'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('link', { name: label('openInKnowledgeBase') }))
    await user.tab()
    expect(document.activeElement?.textContent).toBe(label('useAsSource'))
  })
})
