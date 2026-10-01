// @vitest-environment jsdom

import { useCallback, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { webcrypto } from 'node:crypto'
import {
  IntegrationOperationService,
  type IntegrationOperation,
  type IntegrationOperationStore,
  type IntegrationResource,
  type IntegrationWriteRuntime,
} from '@bitsentry-ce/core/features/plugins'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', async () => {
  // Keys are returned as they are, except where a value is interpolated: those use the real en-US text, so a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const english = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/i18n/src/locales/en-US/incidents.json'), 'utf8')) as Record<string, string>
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  return { useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options === undefined ? key : fill(english[key] ?? key, options) }) }
})

import IncidentIntegrationsRail, {
  IntegrationsRailTriggers,
  useIntegrationsRailState,
} from '@bitsentry-ce/components/investigation/IncidentIntegrationsRail'
import type { IntegrationOperationsPort } from '@bitsentry-ce/components/investigation/IntegrationActionsView'
import type { IntegrationResourcesPort } from '@bitsentry-ce/components/investigation/IntegrationSourcesView'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'
import type { BitsentryServicePorts, RunbookRecord } from '@bitsentry-ce/components/services/contracts'

const connectionId = '11111111-1111-4111-8111-111111111111'
const runbook = {
  id: 'rb-1', title: 'Check uptime', description: '', revisionNumber: 1,
  createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
  actions: [{ id: 'a1', type: 'shell', title: 'Uptime', command: 'uptime' }],
} as unknown as RunbookRecord
const services = {
  runbooks: { list: async () => [runbook], getExecution: async () => null, execute: async () => ({ executionId: 'exec-1' }) },
} as unknown as BitsentryServicePorts

function ticket(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: 'incident-1', connectionId, connectionName: 'Itop Bitsentry', resourceType: 'ticket', externalId: '3',
    url: 'https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=3', title: 'Logon Failure - Unknown user or bad password',
    state: { ref: 'R-000003', status: 'resolved', className: 'UserRequest' }, observedAt: '2026-09-30T09:00:00.000Z', ...overrides,
  }
}
function document_(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: 'incident-1', connectionId, connectionName: 'Team wiki', resourceType: 'document', externalId: 'doc-1',
    url: 'https://outline.example/doc/1', title: 'Sandbox integration read example', state: {}, observedAt: '2026-09-30T08:00:00.000Z', ...overrides,
  }
}
function operation(overrides: Partial<IntegrationOperation> = {}): IntegrationOperation {
  return {
    id: '22222222-2222-4222-8222-222222222222', threadId: 'incident-1', connectionId, connectionName: 'Itop Bitsentry',
    target: 'https://itop.example/webservices/rest.php', pluginId: 'itop', actionId: 'create_object',
    input: { class: 'UserRequest', fields: { title: 'Disposable Sandbox ticket' }, outputFields: 'ref' },
    publicUpdate: false, requiresCloseRequest: false, pluginVersion: '1.0.0', connectionRevision: 'saved-once', ticketOperation: 'create',
    status: 'proposed', createdAt: '2026-09-30T09:00:00.000Z', updatedAt: '2026-09-30T09:00:00.000Z', ...overrides,
  }
}
const resourcesPort = (rows: { current: IntegrationResource[] }): IntegrationResourcesPort => ({ list: vi.fn(async () => rows.current), select: vi.fn(async () => undefined) })
const operationsPort = (rows: { current: IntegrationOperation[] }): IntegrationOperationsPort => ({ list: vi.fn(async () => rows.current), approve: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) })

/** An Incident host: its own Runbook rail flag, the two header entry points, the chat composer and the rail. */
function Host({ resources, operations, runbookOpenAtStart = false, disabled = false }: {
  resources?: IntegrationResourcesPort; operations?: IntegrationOperationsPort; runbookOpenAtStart?: boolean; disabled?: boolean
}) {
  const [runbookOpen, setRunbookOpen] = useState(runbookOpenAtStart)
  const closeRunbookRail = useCallback(() => { setRunbookOpen(false) }, [])
  const rail = useIntegrationsRailState({ incidentId: 'incident-1', runbookRailOpen: runbookOpen, closeRunbookRail })
  return (
    <BitsentryServicesProvider services={services}>
      <button type="button" aria-pressed={runbookOpen} onClick={() => { setRunbookOpen((open) => !open) }}>Runbook Results</button>
      <IntegrationsRailTriggers state={rail} />
      <textarea aria-label="Message" />
      <IncidentIntegrationsRail
        threadId="incident-1" disabled={disabled} isOpen={rail.open} view={rail.view} focusOnOpen={rail.openedByUser}
        onViewChange={rail.setView} onClose={rail.close} resources={resources} operations={operations} onSummaryChange={rail.reportSummary}
      />
    </BitsentryServicesProvider>
  )
}

const railElement = () => document.querySelector('aside') as HTMLElement
const railIsOpen = () => railElement().getAttribute('aria-hidden') === 'false'
const runbookButton = () => screen.getByRole('button', { name: 'Runbook Results' })
const sourcesTrigger = () => screen.findByRole('button', { name: /incidents\.integrationRail\.sources/ })
const actionsTrigger = () => screen.findByRole('button', { name: /incidents\.integrationRail\.ticketActions/ })
const tab = (name: 'sources' | 'ticketActions') => screen.getByRole('tab', { name: new RegExp(`incidents\\.integrationRail\\.${name}`) })
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => {
  // jsdom lacks the pointer and scroll APIs the Radix Select uses.
  Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined })
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the integrations rail beside the Incident chat', () => {
  it('stays closed until the engineer opens Sources, then stacks the linked resources with the saved-runbook review', async () => {
    render(<Host resources={resourcesPort({ current: [ticket({ selected: true }), document_()] })} />)

    const trigger = await sourcesTrigger()
    expect(railIsOpen()).toBe(false)
    expect(trigger.textContent).toContain('2')

    fireEvent.click(trigger)

    expect(railIsOpen()).toBe(true)
    expect(trigger.getAttribute('aria-pressed')).toBe('true')
    expect(within(railElement()).getByText('2 linked · 1 selected as sources')).toBeTruthy()
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      'Logon Failure - Unknown user or bad password',
      'Sandbox integration read example',
    ])
    expect(screen.getByRole('button', { name: 'incidents.integrationResources.sourceSelected' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'incidents.knowledge.executeTitle' })).toBeTruthy()
  })

  it('shows one right panel at a time: the Runbook rail and the integrations rail hide each other', async () => {
    render(<Host resources={resourcesPort({ current: [ticket()] })} />)
    const trigger = await sourcesTrigger()

    fireEvent.click(trigger)
    expect(railIsOpen()).toBe(true)

    fireEvent.click(runbookButton())
    expect(runbookButton().getAttribute('aria-pressed')).toBe('true')
    expect(railIsOpen()).toBe(false)
    expect(trigger.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(trigger)
    expect(runbookButton().getAttribute('aria-pressed')).toBe('false')
    expect(railIsOpen()).toBe(true)

    fireEvent.click(trigger)
    expect(railIsOpen()).toBe(false)
  })

  it('opens Ticket actions once when a proposal arrives, without stealing focus, and does not reopen a dismissed rail', async () => {
    const rows = { current: [] as IntegrationOperation[] }
    render(<Host operations={operationsPort(rows)} />)
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()
    await tick(2600)
    expect(railIsOpen()).toBe(false)

    rows.current = [operation({ id: 'first' })]
    await tick(2600)

    expect(railIsOpen()).toBe(true)
    expect(tab('ticketActions').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(composer)
    expect((await actionsTrigger()).textContent).toContain('1 pending')

    fireEvent.click(screen.getByRole('button', { name: 'incidents.integrationRail.close' }))
    expect(railIsOpen()).toBe(false)
    await tick(5200)
    expect(railIsOpen()).toBe(false)

    rows.current = [operation({ id: 'first' }), operation({ id: 'second', createdAt: '2026-09-30T10:00:00.000Z' })]
    await tick(2600)
    expect(railIsOpen()).toBe(true)
    expect((await actionsTrigger()).textContent).toContain('2 pending')
  })

  it('only raises the pending count when a proposal arrives while the Runbook rail is open', async () => {
    render(<Host operations={operationsPort({ current: [operation()] })} runbookOpenAtStart />)

    const trigger = await actionsTrigger()
    expect(trigger.textContent).toContain('1 pending')
    expect(railIsOpen()).toBe(false)
    expect(runbookButton().getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the selected operation and a review draft when switching between views', async () => {
    const rows = {
      current: [
        operation({ id: 'newer', createdAt: '2026-09-30T10:00:00.000Z' }),
        operation({ id: 'older', createdAt: '2026-09-30T09:00:00.000Z', actionId: 'apply_stimulus', ticketOperation: 'resolve', input: { class: 'UserRequest', id: 12, stimulus: 'ev_resolve' } }),
      ],
    }
    render(<Host resources={resourcesPort({ current: [document_({ selected: true })] })} operations={operationsPort(rows)} />)
    await waitFor(() => { expect(railIsOpen()).toBe(true) })
    const older = await screen.findByRole('button', { name: /incidents\.integrationWrites\.operation\.resolve/ })
    fireEvent.click(older)
    expect(screen.getByRole('region', { name: 'incidents.integrationWrites.operation.resolve' })).toBeTruthy()

    fireEvent.click(tab('sources'))
    expect(tab('sources').getAttribute('aria-selected')).toBe('true')
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(await screen.findByRole('button', { name: /incidents\.knowledge\.picker\.placeholder/ }))
    await user.click(await screen.findByRole('option', { name: /Check uptime/ }))
    fireEvent.change(screen.getByLabelText('incidents.knowledge.parameters'), { target: { value: '{"host":"db-1"}' } })

    fireEvent.click(tab('ticketActions'))
    expect(tab('ticketActions').getAttribute('aria-selected')).toBe('true')
    expect(older.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: 'incidents.integrationWrites.operation.resolve' })).toBeTruthy()

    fireEvent.click(tab('sources'))
    expect((screen.getByLabelText('incidents.knowledge.parameters') as HTMLTextAreaElement).value).toBe('{"host":"db-1"}')
  })

  it('closes on Escape and returns focus to the button that opened it', async () => {
    render(<Host resources={resourcesPort({ current: [ticket()] })} />)
    const trigger = await sourcesTrigger()

    trigger.focus()
    fireEvent.click(trigger)
    expect(railElement().contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })

    expect(railIsOpen()).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('closes an open runbook list on the first Escape and the rail only on the second', async () => {
    render(<Host resources={resourcesPort({ current: [ticket({ selected: true })] })} />)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    fireEvent.click(await sourcesTrigger())
    await user.click(await screen.findByRole('button', { name: /incidents\.knowledge\.picker\.placeholder/ }))
    expect(screen.getByRole('listbox')).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(railIsOpen()).toBe(true)

    await user.keyboard('{Escape}')
    expect(railIsOpen()).toBe(false)
  })

  it('shows sources and ticket actions read-only for an archived incident', async () => {
    render(<Host resources={resourcesPort({ current: [ticket()] })} operations={operationsPort({ current: [operation()] })} disabled />)
    await waitFor(() => { expect(railIsOpen()).toBe(true) })

    expect((screen.getByRole('button', { name: 'incidents.integrationWrites.approve' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'incidents.integrationWrites.cancel' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(tab('sources'))
    expect((screen.getByRole('button', { name: 'incidents.integrationResources.useAsSource' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a refresh failure without hiding what it already showed', async () => {
    const port = resourcesPort({ current: [ticket()] })
    render(<Host resources={port} />)
    fireEvent.click(await sourcesTrigger())
    expect(screen.getByRole('article')).toBeTruthy()

    vi.mocked(port.list).mockRejectedValue(new Error('offline'))
    await tick(5200)

    expect(screen.getByRole('alert').textContent).toBe('incidents.integrationResources.error')
    expect(screen.getByRole('article')).toBeTruthy()
  })
})

const staleMessage = 'Connection changed. Create a new preview.'

function memoryStore(): IntegrationOperationStore {
  const rows = new Map<string, IntegrationOperation>()
  return {
    list: async (threadId) => [...rows.values()].filter((row) => row.threadId === threadId),
    get: async (id) => rows.get(id) ?? null,
    create: async (row) => { rows.set(row.id, row) },
    transition: async (id, expected, patch) => {
      const row = rows.get(id)
      if (row === undefined || row.status !== expected) return false
      rows.set(id, { ...row, ...patch })
      return true
    },
  }
}

describe('a refused approval in the rail', () => {
  it('stays visible across list refreshes while the operation waits, unchanged, for a new preview', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} })
    const runtime: IntegrationWriteRuntime = {
      connection: { id: connectionId, name: 'Team wiki', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [], revision: 'saved-once' },
      plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] },
      execute,
      read: vi.fn(),
    }
    const service = new IntegrationOperationService(memoryStore(), async () => runtime)
    const proposal = await service.propose('incident-1', { connectionId, actionId: 'create_document', input: { title: 'Exact approved title' } })
    const port: IntegrationOperationsPort = {
      list: (threadId) => service.list(threadId),
      approve: (threadId, id, closeRequested) => service.approve(threadId, id, closeRequested),
      cancel: (threadId, id) => service.cancel(threadId, id),
    }
    render(<Host operations={port} />)
    await waitFor(() => { expect(railIsOpen()).toBe(true) })

    runtime.connection.revision = 'saved-again'
    fireEvent.click(screen.getByRole('button', { name: 'incidents.integrationWrites.approve' }))
    expect((await screen.findByRole('alert')).textContent).toBe(staleMessage)

    await tick(5200)

    expect(screen.getByRole('alert').textContent).toBe(staleMessage)
    expect(screen.queryByText('incidents.integrationWrites.error')).toBeNull()
    expect((screen.getByRole('button', { name: 'incidents.integrationWrites.approve' }) as HTMLButtonElement).disabled).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect((await service.list('incident-1')).find((row) => row.id === proposal.id)?.status).toBe('proposed')
  })
})
