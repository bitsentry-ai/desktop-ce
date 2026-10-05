// @vitest-environment jsdom

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
  // The real en-US text, with the plural form i18next would pick, so a count or a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const load = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), `../../packages/i18n/src/locales/en-US/${name}.json`), 'utf8')) as Record<string, string>
  const english = { ...load('common'), ...load('incidents') }
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  const t = (key: string, options: Record<string, unknown> = {}) => {
    const plural = typeof options.count === 'number' ? english[`${key}_${options.count === 1 ? 'one' : 'other'}`] : undefined
    return fill(plural ?? english[key] ?? key, options)
  }
  return { useTranslation: () => ({ t }) }
})

import IncidentArtifactsPanel, { ArtifactsPanelTrigger } from '@bitsentry-ce/components/investigation/IncidentArtifactsPanel'
import { useArtifactsPanelState } from '@bitsentry-ce/components/investigation/artifacts-panel-state'
import IncidentArtifactsRail, { type IncidentArtifactsMessage } from '@bitsentry-ce/components/investigation/IncidentArtifactsRail'
import type { IntegrationOperationsPort } from '@bitsentry-ce/components/investigation/IntegrationActionsView'
import type { IntegrationDelivery, IntegrationDeliveriesPort } from '@bitsentry-ce/components/investigation/IntegrationDeliveriesView'
import type { IntegrationResourcesPort } from '@bitsentry-ce/components/investigation/IntegrationSourcesView'
import { BitsentryServicesProvider } from '@bitsentry-ce/components/services/context'
import type { AgentServicePort, BitsentryServicePorts, RunbookAuthoringProposalReview, RunbookExecutionStatus, RunbookRecord } from '@bitsentry-ce/components/services/contracts'

const INCIDENT = 'incident-1'
const connectionId = '11111111-1111-4111-8111-111111111111'
const RESULTS_KEY = 'bitsentry_results'
const RESULT_TRACES_KEY = 'bitsentry_result_traces'
const NO_MESSAGES: IncidentArtifactsMessage[] = []

const savedRunbook = {
  id: 'rb-1', title: 'Check uptime', description: '', revisionNumber: 1,
  createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z',
  actions: [{ id: 'a1', type: 'shell', title: 'Uptime', command: 'uptime' }],
} as unknown as RunbookRecord

/** What the agent proposes for runbook authoring; a test changes it between refreshes. */
const proposals = { current: [] as RunbookAuthoringProposalReview[] }
const services = {
  runbooks: { list: async () => [savedRunbook], getExecution: async () => null, execute: async () => ({ executionId: 'exec-1' }), onExecutionEvent: () => () => undefined },
  agent: { listRunbookAuthoringProposals: async () => proposals.current } as unknown as AgentServicePort,
} as unknown as BitsentryServicePorts

function ticket(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: INCIDENT, connectionId, connectionName: 'Itop Bitsentry', resourceType: 'ticket', externalId: '3',
    url: 'https://itop.example/pages/UI.php?operation=details&class=UserRequest&id=3', title: 'Logon Failure - Unknown user or bad password',
    state: { ref: 'R-000003', status: 'resolved', className: 'UserRequest' }, observedAt: '2026-10-05T09:00:00.000Z', ...overrides,
  }
}
function document_(overrides: Partial<IntegrationResource> = {}): IntegrationResource {
  return {
    threadId: INCIDENT, connectionId, connectionName: 'Team wiki', resourceType: 'document', externalId: 'doc-1',
    url: 'https://outline.example/doc/1', title: 'Sandbox integration read example', state: {}, observedAt: '2026-10-05T08:00:00.000Z', ...overrides,
  }
}
function operation(overrides: Partial<IntegrationOperation> = {}): IntegrationOperation {
  return {
    id: '22222222-2222-4222-8222-222222222222', threadId: INCIDENT, connectionId, connectionName: 'Itop Bitsentry',
    target: 'https://itop.example/webservices/rest.php', pluginId: 'itop', actionId: 'create_object',
    input: { class: 'UserRequest', fields: { title: 'Disposable Sandbox ticket' }, outputFields: 'ref' },
    publicUpdate: false, requiresCloseRequest: false, pluginVersion: '1.0.0', connectionRevision: 'saved-once', ticketOperation: 'create',
    status: 'proposed', createdAt: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z', ...overrides,
  }
}
const delivery = (overrides: Partial<IntegrationDelivery> = {}): IntegrationDelivery => ({
  id: '33333333-3333-4333-8333-333333333333', eventId: 'evt-change-0001', channel: 'itop:changes', state: 'failed', externalId: null, updatedAt: '2026-10-05T09:30:00.000Z', ...overrides,
})
const draft = (overrides: Partial<RunbookAuthoringProposalReview> = {}): RunbookAuthoringProposalReview => ({
  proposalId: 'proposal-1', artifactId: 'artifact-1', artifactVersion: 1, isLatest: true, status: 'pending_approval', approvalRequired: true, saved: false,
  supportsOperationApproval: false, kind: 'create_new_runbook', incidentThreadId: INCIDENT,
  proposedRunbook: { id: 'draft-runbook', title: 'Sandbox: Logon failure triage', description: 'Check repeated logon failures.', revisionNumber: 1, actionCount: 1, actions: [{ id: 'health', type: 'http', title: 'Check health' }] },
  validation: { valid: true, errors: [], warnings: [] },
  operationDiffs: [{ operationId: 'create-runbook', type: 'create_runbook', rationale: 'Create the runbook.', riskLabels: [], before: null, after: {} }],
  nextStep: 'Review it.', ...overrides,
})

/** Runs of this incident, as the Runbook rail keeps them for the incident. */
function storeRuns(runs: Array<{ n: number; title: string; status: RunbookExecutionStatus }>) {
  const uuid = (n: number, part: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(part).repeat(12)}`
  const executions = runs.map((run) => ({
    executionId: uuid(run.n, 2), runbookId: `runbook-${run.n}`, incidentThreadId: INCIDENT, runbookTitle: run.title, status: run.status,
    startedAt: `2026-10-05T09:0${run.n}:00.000Z`, completedAt: `2026-10-05T09:0${run.n}:30.000Z`,
    steps: [{ actionId: `step-${run.n}`, order: 1, type: 'shell', title: 'Collect logs', status: run.status === 'failed' ? 'failed' : 'completed', output: `output of ${run.title}` }],
  }))
  localStorage.setItem(RESULTS_KEY, JSON.stringify(runs.map((run, index) => ({
    id: uuid(run.n, 1), executionId: executions[index]!.executionId, incidentThreadId: INCIDENT, runbookId: `runbook-${run.n}`, runbookTitle: run.title, status: run.status,
    startedAt: executions[index]!.startedAt, completedAt: executions[index]!.completedAt,
  }))))
  localStorage.setItem(RESULT_TRACES_KEY, JSON.stringify(Object.fromEntries(runs.map((run, index) => [uuid(run.n, 1), { execution: executions[index] }]))))
  act(() => { window.dispatchEvent(new Event('bitsentry:results-updated')) })
}
const failedRun = { n: 1, title: 'Analyze server 227', status: 'failed' as const }
const completedRun = { n: 2, title: 'Restart nginx check', status: 'completed' as const }

const resourcesPort = (rows: { current: IntegrationResource[] }): IntegrationResourcesPort => ({ list: async () => rows.current, select: async () => undefined })
const operationsPort = (rows: { current: IntegrationOperation[] }): IntegrationOperationsPort => ({
  list: async (threadId) => rows.current.filter((row) => row.threadId === threadId),
  approve: async () => undefined, cancel: async () => undefined,
})
const deliveriesPort = (rows: { current: IntegrationDelivery[] }): IntegrationDeliveriesPort => ({ list: async () => rows.current, retry: async () => undefined, reconcile: async () => undefined })

interface Ports { resources?: IntegrationResourcesPort; operations?: IntegrationOperationsPort; deliveries?: IntegrationDeliveriesPort }
/** The Incident host: the header button, the chat composer and the panel, with the one open state between them. */
function Host({ threadId = INCIDENT, messages = NO_MESSAGES, disabled = false, ...ports }: Ports & { threadId?: string; messages?: IncidentArtifactsMessage[]; disabled?: boolean }) {
  const state = useArtifactsPanelState({ incidentId: threadId })
  return (
    <BitsentryServicesProvider services={services}>
      <ArtifactsPanelTrigger state={state} />
      <textarea aria-label="Message" />
      <IncidentArtifactsPanel
        key={threadId} threadId={threadId} disabled={disabled} messages={messages} isOpen={state.open} filter={state.filter} focusOnOpen={state.openedByUser}
        onFilterChange={state.setFilter} onClose={state.close} onSummaryChange={state.reportSummary} {...ports}
      />
    </BitsentryServicesProvider>
  )
}

const panel = () => document.querySelector('aside') as HTMLElement
const panelIsOpen = () => panel().getAttribute('aria-hidden') === 'false'
const trigger = () => screen.getByRole('button', { name: /^Artifacts/ })
const chip = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
const chipCounts = () => ['All', 'Sources', 'Runbooks', 'Ticket actions', 'Deliveries'].map((label) => within(chip(label)).getByText(/^\d+$/).textContent)
const needsYou = () => screen.getByRole('region', { name: 'Needs you' })
const noNeedsYou = () => screen.queryByRole('region', { name: 'Needs you' })
const runbookResults = () => screen.getByRole('region', { name: 'Runbook Results' })
const names = (container: HTMLElement) => within(container).getAllByRole('article').map((article) => article.getAttribute('aria-label')).sort()
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const scrolled: Element[] = []

/** One of each kind that waits for the engineer, and one of each that does not. */
function renderBusyIncident() {
  proposals.current = [draft()]
  storeRuns([failedRun, completedRun])
  const resources = { current: [ticket(), document_()] }
  const operations = { current: [operation(), operation({ id: 'done', ticketOperation: 'resolve', actionId: 'apply_stimulus', status: 'succeeded' })] }
  const deliveries = { current: [delivery(), delivery({ id: 'ok', eventId: 'evt-ok', state: 'succeeded' })] }
  render(<Host resources={resourcesPort(resources)} operations={operationsPort(operations)} deliveries={deliveriesPort(deliveries)} />)
  return { resources, operations, deliveries }
}

beforeEach(() => {
  // jsdom lacks the pointer and scroll APIs the Radix Select uses.
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined,
    scrollIntoView(this: Element) { scrolled.push(this) },
  })
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
  localStorage.clear()
  proposals.current = []
  scrolled.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.useRealTimers()
})

describe('the Artifacts panel counts', () => {
  it('counts every kind of artifact on the header button, the panel and the filters, and says how many need the engineer', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })

    await waitFor(() => { expect(within(trigger()).getByText('9')).toBeTruthy() })
    expect(within(trigger()).getByText('4 need you')).toBeTruthy()
    expect(within(panel()).getByText(/^9 items/)).toBeTruthy()
    expect(within(panel()).getByText('4 need you')).toBeTruthy()
    expect(within(needsYou()).getByText('4')).toBeTruthy()
  })

  it('has no Artifacts button until the incident has an artifact', async () => {
    const operations = { current: [] as IntegrationOperation[] }
    render(<Host operations={operationsPort(operations)} />)
    await tick(2600)
    expect(screen.queryByRole('button', { name: /^Artifacts/ })).toBeNull()

    operations.current = [operation({ status: 'succeeded' })]
    await tick(2600)

    expect(within(trigger()).getByText('1')).toBeTruthy()
    expect(screen.queryByText(/need you/)).toBeNull()
  })

  it('says a single item needs you in the singular', async () => {
    render(<Host operations={operationsPort({ current: [operation()] })} />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })

    expect(within(trigger()).getByText('1 needs you')).toBeTruthy()
  })
})

describe('"Needs you"', () => {
  it('lists what waits for a person and nothing that is settled', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })

    expect(names(needsYou())).toEqual([
      'Analyze server 227',
      'Create ticket',
      'Sandbox: Logon failure triage',
      'Ticket change from iTop evt-change-0…',
    ])
  })

  it('does not list an item again in its own section while All is chosen, and lists everything of one kind under its filter', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })

    expect(screen.getAllByRole('article', { name: 'Create ticket' })).toHaveLength(1)
    expect(within(needsYou()).queryByRole('article', { name: 'Resolve ticket' })).toBeNull()
    expect(screen.getByRole('article', { name: 'Resolve ticket' })).toBeTruthy()
    expect(screen.getAllByRole('article', { name: /^Ticket change from iTop/ })).toHaveLength(2)

    fireEvent.click(chip('Ticket actions'))

    expect(noNeedsYou()).toBeNull()
    expect(screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'))).toEqual(['Create ticket', 'Resolve ticket'])

    fireEvent.click(chip('Deliveries'))
    expect(screen.getAllByRole('article', { name: /^Ticket change from iTop/ })).toHaveLength(2)
    expect(screen.queryByRole('article', { name: 'Create ticket' })).toBeNull()

    fireEvent.click(chip('All'))
    expect(needsYou()).toBeTruthy()
  })

  it('keeps every run and draft in Runbook Results, whether All or Runbooks is chosen', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })
    const listed = () => ['Sandbox: Logon failure triage', 'Analyze server 227', 'Restart nginx check'].map((title) => within(runbookResults()).getByRole('button', { name: new RegExp(`^${title}`) }).textContent)

    expect(listed()).toHaveLength(3)

    fireEvent.click(chip('Runbooks'))

    expect(noNeedsYou()).toBeNull()
    expect(listed()).toHaveLength(3)
    expect(screen.queryByRole('article', { name: 'Create ticket' })).toBeNull()
  })

  it('opens a draft for review in Runbook Results and scrolls to it, without a decision on its own row', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })
    const row = within(needsYou()).getByRole('article', { name: 'Sandbox: Logon failure triage' })
    expect(await within(runbookResults()).findByRole('button', { name: 'Approve' })).toBeTruthy()
    fireEvent.click(within(runbookResults()).getByRole('button', { name: /^Restart nginx check/ }))
    expect(within(runbookResults()).queryByRole('button', { name: 'Approve' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'Review' }))

    expect(within(runbookResults()).getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(runbookResults()).getByRole('button', { name: 'Reject' })).toBeTruthy()
    expect(within(runbookResults()).getByRole('button', { name: 'Revise in chat' })).toBeTruthy()
    expect(scrolled.at(-1)).toBe(runbookResults())
    expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull()
  })

  it('opens a failed run in Runbook Results from its row', async () => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })
    expect(await within(runbookResults()).findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(within(runbookResults()).queryByText('output of Analyze server 227')).toBeNull()

    fireEvent.click(within(within(needsYou()).getByRole('article', { name: 'Analyze server 227' })).getByRole('button', { name: 'View' }))

    expect(within(runbookResults()).getAllByText('output of Analyze server 227').length).toBeGreaterThan(0)
    expect(within(runbookResults()).queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(scrolled.at(-1)).toBe(runbookResults())
  })
})

describe('Runbook Results layout', () => {
  const classes = (element: Element) => element.getAttribute('class') ?? ''
  const everyElement = (container: Element) => [...container.querySelectorAll('*')]
  /** Areas that scroll on their own: in a box that is too short they hide what is inside them. */
  const innerScrollAreas = (container: Element) => everyElement(container).filter((element) => /(^|\s)overflow-(y-)?(auto|scroll)(\s|$)/.test(classes(element)))
  /** Rows that take a fixed share of the box height: in a box that is too short the steps row shrinks to nothing. */
  const fixedRows = (container: Element) => everyElement(container).filter((element) => /(^|\s)grid-rows-\[/.test(classes(element)))

  async function openRun() {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })
    expect(await within(runbookResults()).findByRole('button', { name: 'Approve' })).toBeTruthy()
    fireEvent.click(within(runbookResults()).getByRole('button', { name: /^Restart nginx check/ }))
  }

  it.each(['All', 'Runbooks'])('gives the selected run its natural height under %s, so its steps cannot collapse under the output', async (filter) => {
    await openRun()
    fireEvent.click(chip(filter))
    const results = runbookResults()

    expect(within(results).getByText('Live Steps')).toBeTruthy()
    expect(within(results).getByRole('button', { name: /^1\s*Collect logs/ })).toBeTruthy()
    expect(within(results).getByText('Output')).toBeTruthy()
    expect(fixedRows(results)).toEqual([])
    expect(innerScrollAreas(results)).toEqual([])
  })

  it.each(['All', 'Runbooks'])('scrolls the whole panel under %s', async (filter) => {
    renderBusyIncident()
    await waitFor(() => { expect(chipCounts()).toEqual(['9', '2', '3', '2', '2']) })
    fireEvent.click(chip(filter))

    const scroller = runbookResults().closest('.overflow-y-auto')

    expect(scroller).toBeTruthy()
    expect(panel().contains(scroller)).toBe(true)
  })

  it('keeps the full-height layout in the Desktop rail, where the list and the details scroll inside their own rows', async () => {
    storeRuns([failedRun, completedRun])
    render(
      <BitsentryServicesProvider services={services}>
        <IncidentArtifactsRail isOpen onClose={() => undefined} messages={NO_MESSAGES} incidentId={INCIDENT} />
      </BitsentryServicesProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /^Restart nginx check/ }))
    const rail = document.querySelector('aside') as HTMLElement

    expect(within(rail).getByText('Live Steps')).toBeTruthy()
    expect(fixedRows(rail).length).toBeGreaterThanOrEqual(2)
    expect(innerScrollAreas(rail).length).toBeGreaterThanOrEqual(2)
  })
})

describe('opening the panel', () => {
  it('opens by itself once when the incident first has runbook results, without taking focus from the chat, and stays closed once dismissed', async () => {
    render(<Host />)
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()
    await tick(2600)
    expect(panelIsOpen()).toBe(false)

    storeRuns([completedRun])
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })
    expect(document.activeElement).toBe(composer)

    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }))
    expect(panelIsOpen()).toBe(false)
    storeRuns([completedRun, failedRun])
    await tick(5200)

    expect(panelIsOpen()).toBe(false)
    expect(within(trigger()).getByText('2')).toBeTruthy()
  })

  it('opens once for a ticket action that was not seen before, shows it under "Needs you", and does not reopen a panel that was dismissed', async () => {
    const rows = { current: [] as IntegrationOperation[] }
    render(<Host operations={operationsPort(rows)} />)
    const composer = screen.getByRole('textbox', { name: 'Message' })
    composer.focus()
    await tick(2600)
    expect(panelIsOpen()).toBe(false)

    rows.current = [operation({ id: 'first' })]
    await tick(2600)

    expect(panelIsOpen()).toBe(true)
    expect(names(needsYou())).toEqual(['Create ticket'])
    expect(document.activeElement).toBe(composer)

    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }))
    await tick(5200)
    expect(panelIsOpen()).toBe(false)

    rows.current = [operation({ id: 'first' }), operation({ id: 'second', createdAt: '2026-10-05T10:00:00.000Z' })]
    await tick(2600)
    expect(panelIsOpen()).toBe(true)
    expect(within(trigger()).getByText('2 need you')).toBeTruthy()
  })

  it('opens once for a runbook draft that was not seen before', async () => {
    storeRuns([completedRun])
    const view = render(<Host />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }))

    proposals.current = [draft()]
    view.rerender(<Host messages={[]} />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })
    expect(names(needsYou())).toEqual(['Sandbox: Logon failure triage'])

    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }))
    view.rerender(<Host messages={[]} />)
    await tick(2600)
    expect(panelIsOpen()).toBe(false)
  })

  it('shows everything when it opens by itself, so what needs the engineer is on top', async () => {
    const rows = { current: [] as IntegrationOperation[] }
    render(<Host resources={resourcesPort({ current: [ticket()] })} operations={operationsPort(rows)} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Artifacts/ }))
    fireEvent.click(chip('Sources'))
    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }))

    rows.current = [operation()]
    await tick(2600)

    expect(panelIsOpen()).toBe(true)
    expect(names(needsYou())).toEqual(['Create ticket'])
  })

  it('starts closed for another incident', async () => {
    const rows = { current: [operation()] }
    const operations = operationsPort(rows)
    const view = render(<Host operations={operations} />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })

    view.rerender(<Host threadId="incident-2" operations={operations} />)

    expect(panelIsOpen()).toBe(false)
    await tick(2600)
    expect(panelIsOpen()).toBe(false)
    expect(screen.queryByRole('button', { name: /^Artifacts/ })).toBeNull()
  })

  it('closes an open list of saved runbooks on the first Escape and the panel only on the second', async () => {
    render(<Host resources={resourcesPort({ current: [ticket({ selected: true })] })} />)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    fireEvent.click(await screen.findByRole('button', { name: /^Artifacts/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run a saved runbook' }))
    await user.click(await screen.findByRole('button', { name: /Choose a saved runbook/ }))
    expect(screen.getByRole('listbox')).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(panelIsOpen()).toBe(true)

    await user.keyboard('{Escape}')
    expect(panelIsOpen()).toBe(false)
  })

  it('closes on Escape and returns focus to the button that opened it', async () => {
    render(<Host resources={resourcesPort({ current: [ticket()] })} />)
    const button = await screen.findByRole('button', { name: /^Artifacts/ })

    button.focus()
    fireEvent.click(button)
    expect(panel().contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })

    expect(panelIsOpen()).toBe(false)
    expect(document.activeElement).toBe(button)
  })
})

describe('ticket actions in the panel', () => {
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
  async function proposeDocument() {
    const runtime: IntegrationWriteRuntime = {
      connection: { id: connectionId, name: 'Team wiki', pluginId: 'outline', target: 'https://outline.example/api', enabled: true, authMode: 'token', availability: 'configured', actions: [], revision: 'saved-once' },
      plugin: { id: 'outline', name: 'Outline', version: '1.0.0', description: 'Documents', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_document', title: 'Create', description: 'Create', riskLevel: 'write', fields: [{ key: 'title', label: 'Title', type: 'string', required: true }] }] },
      execute: async () => ({ pluginId: 'outline', actionId: 'create_document', ok: true, status: 200, summary: 'Created', data: { id: 'doc-9' } }),
      read: vi.fn(),
    }
    const service = new IntegrationOperationService(memoryStore(), async () => runtime)
    const proposal = await service.propose(INCIDENT, { connectionId, actionId: 'create_document', input: { title: 'Exact approved title' } })
    const port: IntegrationOperationsPort = {
      list: (threadId) => service.list(threadId),
      approve: (threadId, id, closeRequested) => service.approve(threadId, id, closeRequested),
      cancel: (threadId, id) => service.cancel(threadId, id),
    }
    return { runtime, service, proposal, port }
  }

  it('applies exactly the proposed change when it is approved from "Needs you", and the item leaves "Needs you"', async () => {
    const { service, proposal, port } = await proposeDocument()
    render(<Host operations={port} />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })
    const card = within(needsYou()).getByRole('article', { name: 'create_document' })
    expect(within(card).getByText('Exact approved title')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Approve this exact change' }))

    await waitFor(() => { expect(noNeedsYou()).toBeNull() })
    const settled = (await service.list(INCIDENT)).find((row) => row.id === proposal.id)
    expect(settled?.status).toBe('succeeded')
    expect(settled?.result).toMatchObject({ id: 'doc-9' })
    expect(within(screen.getByRole('article', { name: 'create_document' })).getByText('Succeeded')).toBeTruthy()
  })

  it('keeps a refusal on its card, across list refreshes, while the change still waits unchanged', async () => {
    const { runtime, service, proposal, port } = await proposeDocument()
    render(<Host operations={port} />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })
    runtime.connection.revision = 'saved-again'

    fireEvent.click(screen.getByRole('button', { name: 'Approve this exact change' }))
    const card = within(needsYou()).getByRole('article', { name: 'create_document' })
    expect((await within(card).findByRole('alert')).textContent).toBe(staleMessage)

    await tick(5200)

    expect(within(needsYou()).getByRole('article', { name: 'create_document' })).toBeTruthy()
    expect(within(card).getByRole('alert').textContent).toBe(staleMessage)
    expect((within(card).getByRole('button', { name: 'Approve this exact change' }) as HTMLButtonElement).disabled).toBe(false)
    expect((await service.list(INCIDENT)).find((row) => row.id === proposal.id)).toMatchObject({ status: 'proposed' })
    expect((await service.list(INCIDENT)).find((row) => row.id === proposal.id)?.result).toBeUndefined()
  })

  it('opens a request that just arrived and keeps an older one closed until it is pressed', async () => {
    const rows = { current: [operation({ id: 'older', ticketOperation: 'resolve', actionId: 'apply_stimulus', status: 'succeeded', createdAt: '2026-10-05T08:00:00.000Z' })] }
    render(<Host operations={operationsPort(rows)} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Artifacts/ }))
    const older = () => within(screen.getByRole('article', { name: 'Resolve ticket' })).getByRole('button', { expanded: false })
    expect(older().getAttribute('aria-expanded')).toBe('false')

    rows.current = [...rows.current, operation({ id: 'newer', createdAt: '2026-10-05T10:00:00.000Z' })]
    await tick(2600)

    const newer = within(screen.getByRole('article', { name: 'Create ticket' })).getByRole('button', { name: /Create ticket/ })
    expect(newer.getAttribute('aria-expanded')).toBe('true')
    expect(older().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(older())
    expect(within(screen.getByRole('article', { name: 'Resolve ticket' })).getByRole('button', { name: /Resolve ticket/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('shows tickets and approvals read-only for an archived incident', async () => {
    render(<Host resources={resourcesPort({ current: [ticket()] })} operations={operationsPort({ current: [operation()] })} disabled />)
    await waitFor(() => { expect(panelIsOpen()).toBe(true) })

    expect((screen.getByRole('button', { name: 'Approve this exact change' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Use as source' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('deliveries and sources in the panel', () => {
  it('takes a delivery out of "Needs you" once its retry moves it on', async () => {
    const rows = { current: [delivery()] }
    const port = deliveriesPort(rows)
    port.retry = async () => { rows.current = [delivery({ state: 'processing' })] }
    render(<Host deliveries={port} />)
    expect((await screen.findByRole('button', { name: /^Artifacts/ })).textContent).toContain('1 needs you')
    expect(panelIsOpen()).toBe(false)
    fireEvent.click(trigger())
    const card = within(needsYou()).getByRole('article', { name: /^Ticket change from iTop/ })
    expect(within(card).queryByRole('button', { name: 'Retry state synchronization' })).toBeNull()

    fireEvent.click(within(card).getByRole('button', { expanded: false }))
    fireEvent.click(within(card).getByRole('button', { name: 'Retry state synchronization' }))

    await waitFor(() => { expect(noNeedsYou()).toBeNull() })
    expect(within(screen.getByRole('article', { name: /^Ticket change from iTop/ })).getByText('Processing')).toBeTruthy()
  })

  it('shows "Run a saved runbook" at the bottom only once a source is selected', async () => {
    const rows = { current: [ticket()] }
    const port = resourcesPort(rows)
    port.select = async (_resource, selected) => { rows.current = [ticket({ selected })] }
    render(<Host resources={port} />)
    fireEvent.click(await screen.findByRole('button', { name: /^Artifacts/ }))
    expect(screen.queryByRole('button', { name: 'Run a saved runbook' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Use as source' }))

    const footer = await screen.findByRole('button', { name: 'Run a saved runbook' })
    expect(screen.queryByRole('region', { name: 'Review and execute a saved runbook' })).toBeNull()
    fireEvent.click(footer)
    expect(screen.getByRole('region', { name: 'Review and execute a saved runbook' })).toBeTruthy()
  })
})
