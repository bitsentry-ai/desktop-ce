// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { IntegrationOperationService, type IntegrationOperation, type IntegrationOperationStore, type IntegrationWriteRuntime } from '@bitsentry-ce/core/features/plugins'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import {
  IntegrationOperationsPanel,
  summarizeOperation,
  type IntegrationOperationsPort,
} from '@bitsentry-ce/components/investigation/IntegrationOperationsPanel'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

function portWith(rows: IntegrationOperation[]) {
  const port: IntegrationOperationsPort = {
    list: vi.fn(async () => rows),
    approve: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  }
  return port
}

async function renderPanel(rows: IntegrationOperation[], disabled = false) {
  const port = portWith(rows)
  render(<IntegrationOperationsPanel threadId="thread-1" disabled={disabled} service={port} />)
  await screen.findByRole('region', { name: label('title') })
  return port
}

describe('IntegrationOperationsPanel', () => {
  it('summarizes target, action and field changes without opening the raw payload', async () => {
    await renderPanel([operation()])

    expect(screen.getByText('https://itop.example/webservices/rest.php')).toBeTruthy()
    expect(screen.getByText(label('operation.create'))).toBeTruthy()
    expect(screen.getByText('create_object')).toBeTruthy()
    expect(screen.getByText('UserRequest')).toBeTruthy()

    const changes = screen.getByText(label('changes')).parentElement as HTMLElement
    expect(within(changes).getByText('title')).toBeTruthy()
    expect(within(changes).getByText('QA 565 disposable')).toBeTruthy()
    expect(within(changes).getByText('org_id')).toBeTruthy()
    expect(within(changes).getByText('SELECT Organization WHERE id = 2')).toBeTruthy()
    expect(within(changes).queryByText('outputFields')).toBeNull()

    const details = screen.getByText(label('details')).closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(details).getByText(/"title": "QA 565 disposable"/)).toBeTruthy()
  })

  it('shows lifecycle requests with the ticket and transition and no field changes', async () => {
    await renderPanel([
      operation({
        actionId: 'apply_stimulus',
        ticketOperation: 'resolve',
        input: { class: 'UserRequest', id: 12, stimulus: 'ev_resolve' },
      }),
    ])

    expect(screen.getByText(label('operation.resolve'))).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText('ev_resolve')).toBeTruthy()
    expect(screen.getByText(label('noChanges'))).toBeTruthy()
  })

  it('approves and rejects with exactly the arguments the workflow always used', async () => {
    const row = operation()
    const port = await renderPanel([row])

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    await waitFor(() => { expect(port.approve).toHaveBeenCalledWith('thread-1', row.id, false) })

    fireEvent.click(screen.getByRole('button', { name: label('cancel') }))
    await waitFor(() => { expect(port.cancel).toHaveBeenCalledWith('thread-1', row.id) })
  })

  it('keeps a close approval disabled until the engineer explicitly asks for it', async () => {
    const row = operation({
      actionId: 'apply_stimulus',
      ticketOperation: 'close',
      requiresCloseRequest: true,
      input: { class: 'UserRequest', id: 12, stimulus: 'ev_close' },
    })
    const port = await renderPanel([row])
    const approve = screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement

    expect(approve.disabled).toBe(true)
    fireEvent.click(approve)
    expect(port.approve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    await waitFor(() => { expect(port.approve).toHaveBeenCalledWith('thread-1', row.id, true) })
  })

  it('disables both decisions while the conversation is busy', async () => {
    await renderPanel([operation()], true)

    expect((screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: label('cancel') }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns when the content is public', async () => {
    await renderPanel([operation({ publicUpdate: true })])

    expect(screen.getByRole('note').textContent).toBe(label('public'))
  })

  it('offers no decision on a request that is no longer awaiting approval and keeps the result in the details', async () => {
    await renderPanel([operation({ status: 'uncertain', result: { code: 100 } })])

    expect(screen.queryByRole('button', { name: label('approve') })).toBeNull()
    expect(screen.queryByRole('button', { name: label('cancel') })).toBeNull()
    expect(screen.getByText(label('inspect'))).toBeTruthy()
    expect(screen.getByText(label('uncertain'))).toBeTruthy()

    const details = screen.getByText(label('details')).closest('details') as HTMLDetailsElement
    expect(within(details).getByText(/"code": 100/)).toBeTruthy()
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

describe('a refused approval', () => {
  it('stays visible across list refreshes while the operation waits, unchanged, for a new preview', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const execute = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} })
    const runtime: IntegrationWriteRuntime = {
      connection: { id: '11111111-1111-4111-8111-111111111111', name: 'Team wiki', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [], revision: 'saved-once' },
      plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] },
      execute,
      read: vi.fn(),
    }
    const service = new IntegrationOperationService(memoryStore(), async () => runtime)
    const proposal = await service.propose('thread-1', { connectionId: runtime.connection.id, actionId: 'create_document', input: { title: 'Exact approved title' } })
    const list = vi.fn((threadId: string) => service.list(threadId))
    const port: IntegrationOperationsPort = { list, approve: (threadId, id, closeRequested) => service.approve(threadId, id, closeRequested), cancel: (threadId, id) => service.cancel(threadId, id) }
    render(<IntegrationOperationsPanel threadId="thread-1" disabled={false} service={port} />)
    await screen.findByRole('region', { name: label('title') })

    runtime.connection.revision = 'saved-again'
    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    expect((await screen.findByRole('alert')).textContent).toBe(staleMessage)

    const listsBefore = list.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(5200) })

    expect(list.mock.calls.length).toBeGreaterThan(listsBefore)
    expect(screen.getByRole('alert').textContent).toBe(staleMessage)
    expect(screen.queryByText(label('error'))).toBeNull()
    expect(screen.getByText(label('proposed'))).toBeTruthy()
    expect((screen.getByRole('button', { name: label('approve') }) as HTMLButtonElement).disabled).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    expect((await service.list('thread-1')).find((row) => row.id === proposal.id)?.status).toBe('proposed')
  })

  it('clears when the engineer tries again', async () => {
    const row = operation()
    const port = portWith([row])
    vi.mocked(port.approve).mockRejectedValueOnce(new Error(staleMessage)).mockResolvedValueOnce(undefined)
    render(<IntegrationOperationsPanel threadId="thread-1" disabled={false} service={port} />)
    await screen.findByRole('region', { name: label('title') })

    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: label('approve') }))

    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(port.approve).toHaveBeenCalledTimes(2)
  })

  it('is not shown once the operation is no longer awaiting approval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const rows = [operation()]
    const port = portWith(rows)
    vi.mocked(port.approve).mockRejectedValue(new Error(staleMessage))
    render(<IntegrationOperationsPanel threadId="thread-1" disabled={false} service={port} />)
    await screen.findByRole('region', { name: label('title') })
    fireEvent.click(screen.getByRole('button', { name: label('approve') }))
    await screen.findByRole('alert')

    vi.mocked(port.list).mockResolvedValue([operation({ status: 'cancelled' })])
    await act(async () => { await vi.advanceTimersByTimeAsync(2600) })

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(label('cancelled'))).toBeTruthy()
  })

  it('falls back to the generic message when the failure carries no reason', async () => {
    const port = portWith([operation()])
    vi.mocked(port.approve).mockRejectedValue(new Error('  '))
    render(<IntegrationOperationsPanel threadId="thread-1" disabled={false} service={port} />)
    await screen.findByRole('region', { name: label('title') })

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

  it('lists class, id and stimulus as plain inputs instead of ticket facts', async () => {
    await renderPanel([outline()])

    expect(screen.queryByText(label('fact.class'))).toBeNull()
    expect(screen.queryByText(label('fact.id'))).toBeNull()
    expect(screen.queryByText(label('fact.stimulus'))).toBeNull()

    const changes = screen.getByText(label('changes')).parentElement as HTMLElement
    for (const [key, value] of [['title', 'Postmortem'], ['text', 'Body'], ['id', 'doc-1'], ['class', 'runbook'], ['stimulus', 'draft']]) {
      expect(within(changes).getByText(key)).toBeTruthy()
      expect(within(changes).getByText(value)).toBeTruthy()
    }
    expect(within(changes).queryByText('outputFields')).toBeNull()
  })

  it('keeps every input in the technical details', async () => {
    await renderPanel([outline()])

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
