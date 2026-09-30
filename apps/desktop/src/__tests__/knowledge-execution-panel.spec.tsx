// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IntegrationResource } from '@bitsentry-ce/core/features/plugins'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', async () => {
  // Keys are returned as they are, except where a value is interpolated: those use the real en-US text, so a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const english = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/i18n/src/locales/en-US/incidents.json'), 'utf8')) as Record<string, string>
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  return { useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options === undefined ? key : fill(english[key] ?? key, options) }) }
})

import { KnowledgeExecutionPanel } from '@bitsentry-ce/components/investigation/KnowledgeExecutionPanel'
import { IntegrationResourcesPanel } from '@bitsentry-ce/components/investigation/IntegrationResourcesPanel'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'
import type { BitsentryServicePorts, RunbookRecord } from '@bitsentry-ce/components/services/contracts'

const label = (suffix: string) => `incidents.knowledge.${suffix}`

function runbook(revisionNumber: number, command = 'uptime'): RunbookRecord {
  return {
    id: 'rb-1', title: 'Check uptime', description: '', revisionNumber,
    createdAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    actions: [{ id: 'a1', type: 'shell', title: 'Uptime', command }],
  } as unknown as RunbookRecord
}

function setup(initial: RunbookRecord[] = [runbook(1)]) {
  const world = {
    catalog: initial, listFails: false, executeFails: false, executions: 0,
    execution: {
      runbookId: 'rb-1', runbookTitle: 'Check uptime', status: 'running', startedAt: '2026-09-30T09:10:00.000Z', source: 'manual',
      steps: [{ actionId: 'a1', order: 1, type: 'shell', title: 'Uptime', status: 'completed', output: 'up 3 days' }],
    } as Record<string, unknown>,
  }
  const runbooks = {
    list: vi.fn(async () => {
      if (world.listFails) {
        throw new Error('offline')
      }
      return world.catalog
    }),
    getExecution: vi.fn(async (id: string) => ({ ...world.execution, executionId: id })),
    execute: vi.fn(async (request: { requestKey: string }) => {
      if (world.executeFails) {
        throw new Error('unconfirmed')
      }
      world.executions += 1
      return { executionId: `exec-${String(world.executions)}`, resultId: 'result', requestKey: request.requestKey }
    }),
  }
  return { world, runbooks, services: { runbooks } as unknown as BitsentryServicePorts }
}

function renderPanel(services: BitsentryServicePorts, props: { active?: boolean } = {}) {
  return render(
    <BitsentryServicesProvider services={services}>
      <KnowledgeExecutionPanel threadId="thread-1" disabled={false} {...props} />
    </BitsentryServicesProvider>,
  )
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

async function review() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
  await user.click(await screen.findByRole('combobox', { name: label('runbook') }))
  await user.click(await screen.findByRole('option', { name: /Check uptime/ }))
  fireEvent.click(approveBox())
}
const run = () => fireEvent.click(screen.getByRole('button', { name: label('execute') }))
const approveBox = () => screen.getByLabelText(label('approveExecution')) as HTMLInputElement

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

describe('KnowledgeExecutionPanel', () => {
  it('drops the approval and shows the new steps when the runbook changes after review', async () => {
    const { world, runbooks, services } = setup()
    renderPanel(services)
    await review()
    expect(approveBox().checked).toBe(true)

    world.catalog = [runbook(2, 'rm -rf /tmp/scratch')]
    await tick(5200)

    expect(approveBox().checked).toBe(false)
    expect(screen.getByText('Revision 2')).toBeTruthy()
    expect(screen.getByText(/rm -rf \/tmp\/scratch/)).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe(label('changed'))
    expect((screen.getByRole('button', { name: label('execute') }) as HTMLButtonElement).disabled).toBe(true)
    run()
    expect(runbooks.execute).not.toHaveBeenCalled()

    fireEvent.click(approveBox())
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(1) })
    expect(runbooks.execute).toHaveBeenCalledWith(expect.objectContaining({ runbookId: 'rb-1', expectedRevisionNumber: 2 }))
  })

  it('keeps the approval while the reviewed steps are unchanged', async () => {
    const { world, services } = setup()
    renderPanel(services)
    await review()

    world.catalog = [runbook(1)]
    await tick(5200)

    expect(approveBox().checked).toBe(true)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('clears the selection and approval when the reviewed runbook is removed', async () => {
    const { world, services } = setup()
    renderPanel(services)
    await review()

    world.catalog = []
    await tick(5200)

    expect(screen.queryByLabelText(label('approveExecution'))).toBeNull()
    expect(screen.getByRole('combobox', { name: label('runbook') }).textContent).toBe(label('runbook'))
  })

  it('uses a new request key for each explicit run, even with identical steps and parameters', async () => {
    const { runbooks, services } = setup()
    renderPanel(services)
    await review()
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(1) })

    fireEvent.click(approveBox())
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(2) })

    const keys = runbooks.execute.mock.calls.map(([request]) => request.requestKey)
    expect(keys[0]).not.toBe(keys[1])
  })

  it('keeps the same request key when the same run is retried, and changes it when the parameters change', async () => {
    const { world, runbooks, services } = setup()
    renderPanel(services)
    await review()
    world.executeFails = true
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(1) })
    await screen.findByText(label('executeError'))

    world.executeFails = false
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(2) })

    const [first, retry] = runbooks.execute.mock.calls.map(([request]) => request.requestKey)
    expect(retry).toBe(first)

    fireEvent.change(screen.getByLabelText(label('parameters')), { target: { value: '{"host":"sandbox"}' } })
    fireEvent.click(approveBox())
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(3) })
    expect(runbooks.execute.mock.calls[2]?.[0].requestKey).not.toBe(first)
  })

  it('clears a refresh error once a later refresh succeeds, but keeps an execution error', async () => {
    const { world, services } = setup()
    renderPanel(services)
    await review()
    world.listFails = true
    await tick(5200)
    expect(screen.getByRole('alert').textContent).toBe(label('loadError'))

    world.listFails = false
    await tick(5200)
    expect(screen.queryByText(label('loadError'))).toBeNull()

    world.executeFails = true
    run()
    await screen.findByText(label('executeError'))
    await tick(5200)
    expect(screen.getByText(label('executeError'))).toBeTruthy()
  })

  it('shows the reviewed steps as a numbered list with their command, not as JSON', async () => {
    const { services } = setup()
    const view = renderPanel(services)
    await review()

    const steps = screen.getAllByRole('listitem')
    expect(steps).toHaveLength(1)
    expect(steps[0]?.parentElement?.tagName).toBe('OL')
    expect(steps[0]?.textContent).toContain('1.')
    expect(steps[0]?.textContent).toContain('Uptime')
    expect(steps[0]?.textContent).toContain('shell')
    expect(steps[0]?.querySelector('code')?.textContent).toBe('uptime')
    expect(screen.getByText('Revision 1')).toBeTruthy()
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it('never runs before the engineer explicitly approves the reviewed steps', async () => {
    const { runbooks, services } = setup()
    renderPanel(services)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.click(await screen.findByRole('combobox', { name: label('runbook') }))
    await user.click(await screen.findByRole('option', { name: /Check uptime/ }))

    expect(approveBox().checked).toBe(false)
    expect((screen.getByRole('button', { name: label('execute') }) as HTMLButtonElement).disabled).toBe(true)
    run()
    await tick(200)
    expect(runbooks.execute).not.toHaveBeenCalled()

    fireEvent.click(approveBox())
    run()
    await waitFor(() => { expect(runbooks.execute).toHaveBeenCalledTimes(1) })
  })

  it('shows the result as a status, how long it took, and its output', async () => {
    const { world, services } = setup()
    world.execution = { ...world.execution, status: 'completed', completedAt: '2026-09-30T09:10:05.000Z' }
    renderPanel(services)
    await review()
    run()

    expect(await screen.findByText('common.incidentArtifactsRail.status.completed')).toBeTruthy()
    expect(screen.getByText('Took 5.0s')).toBeTruthy()
    expect(screen.getByText('Check uptime', { selector: 'span' })).toBeTruthy()
    const output = screen.getByText(/up 3 days/)
    expect(output.tagName).toBe('PRE')
    expect(output.textContent).toContain('Uptime')
    expect(screen.queryByText(/"executionId"/)).toBeNull()
  })

  it('says so when a finished run recorded no output', async () => {
    const { world, services } = setup()
    world.execution = { ...world.execution, status: 'failed', steps: [] }
    renderPanel(services)
    await review()
    run()

    expect(await screen.findByText('common.incidentArtifactsRail.status.failed')).toBeTruthy()
    expect(screen.getByText(label('noOutput'))).toBeTruthy()
  })

  it('hides the review controls when inactive but keeps showing a running execution', async () => {
    const { runbooks, services } = setup()
    const view = renderPanel(services)
    await review()
    run()
    await screen.findByText(/up 3 days/)

    view.rerender(
      <BitsentryServicesProvider services={services}>
        <KnowledgeExecutionPanel threadId="thread-1" disabled={false} active={false} />
      </BitsentryServicesProvider>,
    )

    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByText(/up 3 days/)).toBeTruthy()
    const before = runbooks.getExecution.mock.calls.length
    await tick(2200)
    expect(runbooks.getExecution.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('IntegrationResourcesPanel', () => {
  const resource = (selected: boolean): IntegrationResource => ({
    threadId: 'thread-1', connectionId: '11111111-1111-4111-8111-111111111111', connectionName: 'Wiki', resourceType: 'document',
    externalId: 'doc-1', url: 'https://outline.example/doc/1', title: 'Failover guide', state: {}, observedAt: '2026-09-30T00:00:00.000Z', selected,
  })

  it('does not lose a running execution when the last selected source is unchecked', async () => {
    const { services } = setup()
    const rows = { current: [resource(true)] }
    const resources = { list: vi.fn(async () => rows.current), select: vi.fn(async () => undefined) }
    render(
      <BitsentryServicesProvider services={services}>
        <IntegrationResourcesPanel threadId="thread-1" disabled={false} service={resources} />
      </BitsentryServicesProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /incidents.integrationResources.title/ }))
    await review()
    run()
    await screen.findByText(/up 3 days/)

    rows.current = [resource(false)]
    await tick(5200)

    expect(screen.getByText(/up 3 days/)).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows no execution panel until a source has been selected', async () => {
    const { services } = setup()
    const resources = { list: vi.fn(async () => [resource(false)]), select: vi.fn(async () => undefined) }
    render(
      <BitsentryServicesProvider services={services}>
        <IntegrationResourcesPanel threadId="thread-1" disabled={false} service={resources} />
      </BitsentryServicesProvider>,
    )
    await screen.findByText(/Failover guide/)

    expect(screen.queryByText(label('executeTitle'))).toBeNull()
  })
})
