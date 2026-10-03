// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { IntegrationOperation } from '@bitsentry-ce/core/features/plugins'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import {
  IntegrationActionsView,
  summarizeOperation,
  type IntegrationOperationsPort,
} from '@bitsentry-ce/components/investigation/IntegrationActionsView'

afterEach(cleanup)

const label = (suffix: string) => `incidents.integrationWrites.${suffix}`

function operation(overrides: Partial<IntegrationOperation> = {}): IntegrationOperation {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    threadId: 'thread-1',
    connectionId: '11111111-1111-4111-8111-111111111111',
    connectionName: 'Itop Bitsentry',
    target: 'https://itop.example/webservices/rest.php',
    pluginId: 'itop',
    actionId: 'create_object',
    input: {
      class: 'UserRequest',
      fields: { title: 'QA 565 disposable', description: 'Line one\nLine two', org_id: 'SELECT Organization WHERE id = 2' },
      outputFields: 'ref',
    },
    publicUpdate: false,
    requiresCloseRequest: false,
    pluginVersion: '1.0.0',
    connectionRevision: 'saved-once',
    ticketOperation: 'create',
    status: 'proposed',
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}
const resolveRequest = (overrides: Partial<IntegrationOperation> = {}) =>
  operation({ id: '33333333-3333-4333-8333-333333333333', actionId: 'apply_stimulus', ticketOperation: 'resolve', input: { class: 'UserRequest', id: 12, stimulus: 'ev_resolve' }, ...overrides })

function portWith(rows: IntegrationOperation[]) {
  const port: IntegrationOperationsPort = {
    list: vi.fn(async () => rows),
    approve: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  }
  return port
}

/** Holds the rows the way the rail does: a decision refreshes them from the port. */
function Harness({ port, initial, disabled = false, failed = false }: { port: IntegrationOperationsPort; initial: IntegrationOperation[]; disabled?: boolean; failed?: boolean }) {
  const [rows, setRows] = useState(initial)
  return <IntegrationActionsView threadId="thread-1" rows={rows} failed={failed} disabled={disabled} service={port} onRefresh={async () => { setRows(await port.list('thread-1')) }} />
}
function renderView(rows: IntegrationOperation[], options: { disabled?: boolean; failed?: boolean; port?: IntegrationOperationsPort } = {}) {
  const port = options.port ?? portWith(rows)
  render(<Harness port={port} initial={rows} disabled={options.disabled} failed={options.failed} />)
  return port
}
const listItems = () => [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
const proposal = (operationKey: string) => screen.getByRole('region', { name: label(`operation.${operationKey}`) })

describe('the ticket actions view', () => {
  it('lists each operation with its action, connection and status, newest first', () => {
    renderView([operation({ status: 'succeeded' }), resolveRequest({ createdAt: '2026-09-30T00:00:00.000Z', connectionName: 'Itop Sandbox' })])

    const [first, second] = listItems()
    expect(first!.textContent).toContain(label('operation.resolve'))
    expect(first!.textContent).toContain('Itop Sandbox')
    expect(first!.textContent).toContain(label('proposed'))
    expect(second!.textContent).toContain(label('operation.create'))
    expect(second!.textContent).toContain('Itop Bitsentry')
    expect(second!.textContent).toContain(label('succeeded'))
  })

  it('opens on the request awaiting approval and shows its full proposal without the raw payload', () => {
    renderView([resolveRequest({ status: 'succeeded', createdAt: '2026-09-30T00:00:00.000Z' }), operation()])

    const region = proposal('create')
    expect(within(region).getByText('https://itop.example/webservices/rest.php')).toBeTruthy()
    expect(within(region).getByText('create_object')).toBeTruthy()
    expect(within(region).getByText('UserRequest')).toBeTruthy()

    const changes = within(region).getByText(label('changes')).parentElement as HTMLElement
    expect(within(changes).getByText('title')).toBeTruthy()
    expect(within(changes).getByText('QA 565 disposable')).toBeTruthy()
    expect(within(changes).getByText('org_id')).toBeTruthy()
    expect(within(changes).getByText('SELECT Organization WHERE id = 2')).toBeTruthy()
    expect(within(changes).queryByText('outputFields')).toBeNull()

    const details = within(region).getByText(label('details')).closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText(/"title": "QA 565 disposable"/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: label('operation.resolve') })).toBeNull()
  })

  it('shows the proposal of whichever operation the engineer selects', () => {
    renderView([operation(), resolveRequest({ status: 'succeeded' })])
    expect(proposal('create')).toBeTruthy()

    fireEvent.click(listItems().find((item) => item.textContent?.includes(label('operation.resolve')))!)

    const region = proposal('resolve')
    expect(within(region).getByText('12')).toBeTruthy()
    expect(within(region).getByText('ev_resolve')).toBeTruthy()
    expect(within(region).getByText(label('noChanges'))).toBeTruthy()
    expect(screen.queryByRole('region', { name: label('operation.create') })).toBeNull()
  })

  it('approves and rejects the selected request with exactly the arguments the workflow always used', async () => {
    const row = operation()
    const port = renderView([row])

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    await waitFor(() => { expect(port.approve).toHaveBeenCalledWith('thread-1', row.id, false) })

    fireEvent.click(screen.getByRole('button', { name: label('cancel') }))
    await waitFor(() => { expect(port.cancel).toHaveBeenCalledWith('thread-1', row.id) })
  })

  it('shows the new status and withdraws the decision once the refreshed list confirms it', async () => {
    const row = operation()
    const port = portWith([row])
    vi.mocked(port.list).mockResolvedValue([{ ...row, status: 'succeeded' }])
    renderView([row], { port })

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))

    await waitFor(() => { expect(screen.queryByRole('button', { name: label('approve') })).toBeNull() })
    expect(within(proposal('create')).getByText(label('succeeded'))).toBeTruthy()
  })

  it('keeps a close approval disabled until the engineer explicitly asks for it', async () => {
    const row = operation({ actionId: 'apply_stimulus', ticketOperation: 'close', requiresCloseRequest: true, input: { class: 'UserRequest', id: 12, stimulus: 'ev_close' } })
    const port = renderView([row])
    const approve = screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement

    expect(approve.disabled).toBe(true)
    fireEvent.click(approve)
    expect(port.approve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() => { expect(port.approve).toHaveBeenCalledWith('thread-1', row.id, true) })
  })

  it('disables both decisions in an archived conversation', () => {
    renderView([operation()], { disabled: true })

    expect((screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: label('cancel') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks a public update in the list and in the proposal, and never a private note', () => {
    renderView([
      operation({ id: 'private-note', ticketOperation: 'internal_log', createdAt: '2026-09-29T00:00:00.000Z' }),
      operation({ id: 'public-note', ticketOperation: 'public_log', publicUpdate: true, createdAt: '2026-09-30T00:00:00.000Z' }),
    ])
    const [publicItem, privateItem] = listItems()
    expect(within(publicItem!).getByText('incidents.integrationRail.publicBadge')).toBeTruthy()
    expect(within(privateItem!).queryByText('incidents.integrationRail.publicBadge')).toBeNull()

    const publicProposal = proposal('public_log')
    expect(within(publicProposal).getByRole('note').textContent).toBe(label('public'))
    expect(within(publicProposal).getByText('incidents.integrationRail.publicBadge')).toBeTruthy()

    fireEvent.click(privateItem!)
    const privateProposal = proposal('internal_log')
    expect(within(privateProposal).queryByRole('note')).toBeNull()
    expect(within(privateProposal).queryByText('incidents.integrationRail.publicBadge')).toBeNull()
  })

  it('offers no decision on a request that is no longer awaiting approval and keeps the result in the details', () => {
    renderView([operation({ status: 'uncertain', result: { code: 100 } })])

    expect(screen.queryByRole('button', { name: label('approve') })).toBeNull()
    expect(screen.queryByRole('button', { name: label('cancel') })).toBeNull()
    expect(screen.getByText(label('inspect'))).toBeTruthy()
    expect(within(proposal('create')).getByText(label('uncertain'))).toBeTruthy()

    const details = screen.getByText(label('details')).closest('details') as HTMLDetailsElement
    expect(within(details).getByText(/"code": 100/)).toBeTruthy()
  })

  it('reports a list failure', () => {
    renderView([operation()], { failed: true })

    expect(screen.getByRole('alert').textContent).toBe(label('error'))
  })

  it('says when nothing has been proposed yet', () => {
    renderView([])

    expect(screen.getByText('incidents.integrationRail.noActions')).toBeTruthy()
    expect(listItems()).toEqual([])
  })
})

const staleMessage = 'Connection changed. Create a new preview.'

describe('a refused approval', () => {
  it('stays on its operation, which keeps waiting for a new preview, and clears when the engineer tries again', async () => {
    const row = operation()
    const port = portWith([row])
    vi.mocked(port.approve).mockRejectedValueOnce(new Error(staleMessage)).mockResolvedValueOnce(undefined)
    renderView([row], { port })

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    expect((await screen.findByRole('alert')).textContent).toBe(staleMessage)
    expect(within(proposal('create')).getByText(label('proposed'))).toBeTruthy()
    expect((screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  })

  it('falls back to the generic message when the failure carries no reason', async () => {
    const port = portWith([operation()])
    vi.mocked(port.approve).mockRejectedValue(new Error('  '))
    renderView([operation()], { port })

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))

    expect((await screen.findByRole('alert')).textContent).toBe(label('error'))
  })
})

describe('non-iTop operations', () => {
  const outline = () =>
    operation({
      pluginId: 'outline',
      connectionName: 'Team wiki',
      actionId: 'create_document',
      ticketOperation: undefined,
      input: { title: 'Postmortem', text: 'Body', id: 'doc-1', class: 'runbook', stimulus: 'draft', outputFields: 'id' },
    })

  it('lists class, id and stimulus as plain inputs instead of ticket facts', () => {
    renderView([outline()])

    expect(screen.queryByText(label('fact.class'))).toBeNull()
    expect(screen.queryByText(label('fact.id'))).toBeNull()
    expect(screen.queryByText(label('fact.stimulus'))).toBeNull()

    const changes = screen.getByText(label('changes')).parentElement as HTMLElement
    for (const [key, value] of [['title', 'Postmortem'], ['text', 'Body'], ['id', 'doc-1'], ['class', 'runbook'], ['stimulus', 'draft']]) {
      expect(within(changes).getByText(key!)).toBeTruthy()
      expect(within(changes).getByText(value!)).toBeTruthy()
    }
    expect(within(changes).queryByText('outputFields')).toBeNull()
  })

  it('keeps every input in the technical details', () => {
    renderView([outline()])

    const details = screen.getByText(label('details')).closest('details') as HTMLDetailsElement
    for (const text of [/"title": "Postmortem"/, /"id": "doc-1"/, /"class": "runbook"/, /"stimulus": "draft"/, /"outputFields": "id"/]) {
      expect(within(details).getByText(text)).toBeTruthy()
    }
  })
})

describe('summarizeOperation', () => {
  it('labels class, id and stimulus as ticket facts only for iTop', () => {
    const input = { class: 'UserRequest', id: 12, stimulus: 'ev_close' }

    expect(summarizeOperation(operation({ input })).facts).toEqual([
      { key: 'class', value: 'UserRequest' },
      { key: 'id', value: '12' },
      { key: 'stimulus', value: 'ev_close' },
    ])

    const other = summarizeOperation(operation({ pluginId: 'outline', input }))
    expect(other.facts).toEqual([])
    expect(other.changes).toEqual([
      { key: 'class', value: 'UserRequest' },
      { key: 'id', value: '12' },
      { key: 'stimulus', value: 'ev_close' },
    ])
  })

  it('keeps a fields value that is not a field map instead of dropping it', () => {
    const { changes } = summarizeOperation(operation({ pluginId: 'outline', input: { fields: 'raw text' } }))

    expect(changes).toEqual([{ key: 'fields', value: 'raw text' }])
  })

  it('lists field changes first and other request values after, and drops output selection', () => {
    const { changes, facts } = summarizeOperation(
      operation({
        pluginId: 'outline',
        actionId: 'create_document',
        input: { title: 'Postmortem', text: 'Body', nested: { a: 1 } },
      }),
    )

    expect(changes).toEqual([
      { key: 'title', value: 'Postmortem' },
      { key: 'text', value: 'Body' },
      { key: 'nested', value: '{"a":1}' },
    ])
    expect(facts).toEqual([])
  })
})

describe('why a write did not apply', () => {
  const recovery = (suffix: string) => `incidents.integrationRecovery.${suffix}`

  it.each([['credentials_rejected', 'credentials'], ['stale_resource', 'stale'], ['remote_rejected', 'rejected']])('tells the engineer what to do when the remote system refused (%s)', (message, key) => {
    renderView([operation({ status: 'failed', message })])

    expect(within(proposal('create')).getByRole('alert').textContent).toBe(recovery(key))
    expect(within(proposal('create')).getByText(label('failed'))).toBeTruthy()
  })

  it('shows no refusal reason for a failure it cannot explain', () => {
    renderView([operation({ status: 'failed', message: 'something else' })])

    expect(within(proposal('create')).queryByRole('alert')).toBeNull()
  })

  it('keeps an unknown outcome uncertain: it asks to inspect the remote system and never shows a refusal or a success', () => {
    renderView([operation({ status: 'uncertain', message: 'The remote system did not confirm success. Inspect the remote resource before retrying.' })])

    const region = proposal('create')
    expect(within(region).getByText(label('uncertain'))).toBeTruthy()
    expect(within(region).getByText(/Inspect the remote resource/)).toBeTruthy()
    expect(within(region).queryByRole('alert')).toBeNull()
    expect(within(region).queryByText(label('succeeded'))).toBeNull()
  })
})
