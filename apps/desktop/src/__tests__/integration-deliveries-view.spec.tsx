// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@bitsentry-ce/i18n', async () => {
  // Keys are returned as they are, except where a value is interpolated: those use the real en-US text, so a placeholder the code does not fill shows up.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const english = JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/i18n/src/locales/en-US/incidents.json'), 'utf8')) as Record<string, string>
  const fill = (text: string, options: Record<string, unknown>) => text.replace(/{{(\w+)}}/g, (_match, name: string) => String(options[name] ?? `{{${name}}}`))
  return { useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => options === undefined ? key : fill(english[key] ?? key, options) }) }
})

import {
  IntegrationDeliveriesView,
  type IntegrationDelivery,
  type IntegrationDeliveriesPort,
} from '@bitsentry-ce/components/investigation/IntegrationDeliveriesView'

afterEach(cleanup)

const label = (suffix: string) => `incidents.deliveries.${suffix}`
const delivery = (overrides: Partial<IntegrationDelivery> = {}): IntegrationDelivery => ({
  id: '11111111-1111-4111-8111-111111111111', eventId: 'evt-change-0001', channel: 'itop:changes', state: 'succeeded', externalId: null, updatedAt: '2026-10-01T00:00:00.000Z', ...overrides,
})
const failedChange = (overrides: Partial<IntegrationDelivery> = {}) => delivery({ state: 'failed', ...overrides })
const uncertainCreate = (overrides: Partial<IntegrationDelivery> = {}) =>
  delivery({ id: '22222222-2222-4222-8222-222222222222', eventId: 'evt-create-0001', channel: 'itop:create', state: 'uncertain', ...overrides })

function portFor(rows: IntegrationDelivery[]) {
  const port: IntegrationDeliveriesPort = {
    list: vi.fn(async () => rows),
    retry: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
  }
  return port
}

/** The rail owns the rows and hands them down; a recovery refreshes them from the port. */
function Harness({ port, initial, disabled = false, failed = false }: { port: IntegrationDeliveriesPort; initial: IntegrationDelivery[]; disabled?: boolean; failed?: boolean }) {
  const [rows, setRows] = useState(initial)
  return <>
    <button type="button" onClick={() => { void port.list('thread-1').then(setRows) }}>poll</button>
    <IntegrationDeliveriesView threadId="thread-1" rows={rows} failed={failed} disabled={disabled} service={port} onRefresh={async () => { setRows(await port.list('thread-1')) }} />
  </>
}
function renderView(rows: IntegrationDelivery[], options: { disabled?: boolean; failed?: boolean; port?: IntegrationDeliveriesPort } = {}) {
  const port = options.port ?? portFor(rows)
  render(<Harness port={port} initial={rows} disabled={options.disabled} failed={options.failed} />)
  return port
}
const poll = () => { fireEvent.click(screen.getByRole('button', { name: 'poll' })) }
const idField = () => screen.getByRole('textbox', { name: 'incidents.integrationWrites.externalId' }) as HTMLInputElement
const confirmBox = () => screen.getByRole('checkbox', { name: /incidents\.integrationWrites\.inspected/ }) as HTMLInputElement
const reconcileButton = () => screen.getByRole('button', { name: label('reconcile') }) as HTMLButtonElement

describe('the deliveries view', () => {
  it('shows each delivery with what it was and how it ended', () => {
    renderView([delivery(), uncertainCreate({ state: 'reconciled' })])

    const change = screen.getByRole('article', { name: /incidents\.deliveries\.channel\.changes/ })
    expect(within(change).getByText(label('succeeded'))).toBeTruthy()
    const created = screen.getByRole('article', { name: /incidents\.deliveries\.channel\.create/ })
    expect(within(created).getByText(label('reconciled'))).toBeTruthy()
  })

  it('lists what needs review before what already succeeded', () => {
    renderView([
      delivery({ id: 'ok-newest', eventId: 'evt-ok', updatedAt: '2026-10-01T09:00:00.000Z' }),
      failedChange({ id: 'bad-older', eventId: 'evt-bad', updatedAt: '2026-10-01T01:00:00.000Z' }),
    ])

    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      expect.stringContaining('evt-bad'),
      expect.stringContaining('evt-ok'),
    ])
  })

  it('offers no recovery for a delivery that is fine or still processing', () => {
    renderView([delivery(), delivery({ id: 'p', eventId: 'evt-p', state: 'processing' })])

    expect(screen.queryByRole('button', { name: label('retry') })).toBeNull()
    expect(screen.queryByRole('button', { name: label('reconcile') })).toBeNull()
  })

  it('says when nothing has been delivered and when the list cannot be loaded', () => {
    const { unmount } = render(<Harness port={portFor([])} initial={[]} />)
    expect(screen.getByText('incidents.integrationRail.noDeliveries')).toBeTruthy()
    unmount()

    render(<Harness port={portFor([])} initial={[]} failed />)
    expect(screen.getByRole('alert').textContent).toBe(label('error'))
    expect(screen.queryByText('incidents.integrationRail.noDeliveries')).toBeNull()
  })
})

describe('retrying a failed state synchronization', () => {
  it('retries the delivery and then follows the status it moved to', async () => {
    const row = failedChange()
    const port = portFor([row])
    vi.mocked(port.list).mockResolvedValue([{ ...row, state: 'succeeded' }])
    renderView([row], { port })

    fireEvent.click(screen.getByRole('button', { name: label('retry') }))

    await waitFor(() => { expect(port.retry).toHaveBeenCalledWith('thread-1', row.id) })
    await waitFor(() => { expect(screen.queryByRole('button', { name: label('retry') })).toBeNull() })
    expect(screen.getByText(label('succeeded'))).toBeTruthy()
  })

  it('drops the retry as soon as a later list shows the delivery is no longer failed', () => {
    const port = portFor([])
    vi.mocked(port.list).mockResolvedValue([failedChange({ state: 'succeeded' })])
    renderView([failedChange()], { port })
    expect(screen.getByRole('button', { name: label('retry') })).toBeTruthy()

    poll()

    return waitFor(() => { expect(screen.queryByRole('button', { name: label('retry') })).toBeNull() })
  })

  it('shows why a retry was refused and keeps the control available', async () => {
    const port = portFor([failedChange()])
    vi.mocked(port.retry).mockRejectedValue(new Error('The connection is disabled.'))
    renderView([failedChange()], { port })

    fireEvent.click(screen.getByRole('button', { name: label('retry') }))

    expect((await screen.findByRole('alert')).textContent).toBe('The connection is disabled.')
    expect((screen.getByRole('button', { name: label('retry') }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('falls back to the generic message when the failure carries no reason', async () => {
    const port = portFor([failedChange()])
    vi.mocked(port.retry).mockRejectedValue(new Error('  '))
    renderView([failedChange()], { port })

    fireEvent.click(screen.getByRole('button', { name: label('retry') }))

    expect((await screen.findByRole('alert')).textContent).toBe(label('error'))
  })
})

describe('reconciling an uncertain creation', () => {
  it('asks the engineer to inspect iTop and cannot be confirmed until the ID is entered and the inspection is confirmed', () => {
    const port = renderView([uncertainCreate()])

    expect(screen.getByText(label('inspect'))).toBeTruthy()
    expect(reconcileButton().disabled).toBe(true)
    fireEvent.change(idField(), { target: { value: '4711' } })
    expect(reconcileButton().disabled).toBe(true)
    fireEvent.click(confirmBox())
    expect(reconcileButton().disabled).toBe(false)
    expect(port.reconcile).not.toHaveBeenCalled()
  })

  it('submits the trimmed ID the engineer verified, together with the confirmation', async () => {
    const row = uncertainCreate()
    const port = renderView([row])
    fireEvent.change(idField(), { target: { value: '  4711 ' } })
    fireEvent.click(confirmBox())

    fireEvent.click(reconcileButton())

    await waitFor(() => { expect(port.reconcile).toHaveBeenCalledWith('thread-1', row.id, '4711', true) })
  })

  it('uses the ID iTop returned, not an earlier typed value, once the list reports it', async () => {
    const row = uncertainCreate()
    const port = portFor([])
    vi.mocked(port.list).mockResolvedValue([{ ...row, externalId: '4711' }])
    renderView([row], { port })
    fireEvent.change(idField(), { target: { value: '999' } })
    fireEvent.click(confirmBox())

    poll()
    await screen.findByText('iTop returned ticket ID 4711.')

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(confirmBox().checked).toBe(false)
    fireEvent.click(confirmBox())
    fireEvent.click(reconcileButton())
    await waitFor(() => { expect(port.reconcile).toHaveBeenCalledWith('thread-1', row.id, '4711', true) })
  })

  it('does not keep an old confirmation when the delivery has changed since it was given', async () => {
    const row = uncertainCreate({ externalId: '4711' })
    const port = portFor([])
    vi.mocked(port.list).mockResolvedValue([{ ...row, externalId: '4712' }])
    renderView([row], { port })
    fireEvent.click(confirmBox())
    expect(reconcileButton().disabled).toBe(false)

    poll()
    await screen.findByText('iTop returned ticket ID 4712.')

    expect(confirmBox().checked).toBe(false)
    expect(reconcileButton().disabled).toBe(true)
  })

  it('removes the controls once the creation is confirmed', async () => {
    const row = uncertainCreate()
    const port = portFor([row])
    vi.mocked(port.list).mockResolvedValue([{ ...row, state: 'reconciled', externalId: '4711' }])
    renderView([row], { port })
    fireEvent.change(idField(), { target: { value: '4711' } })
    fireEvent.click(confirmBox())

    fireEvent.click(reconcileButton())

    await waitFor(() => { expect(screen.queryByRole('button', { name: label('reconcile') })).toBeNull() })
    expect(screen.getByText(label('reconciled'))).toBeTruthy()
  })

  it('shows why a confirmation was refused', async () => {
    const port = portFor([uncertainCreate()])
    vi.mocked(port.reconcile).mockRejectedValue(new Error('The external ticket could not be read; keep this outcome uncertain'))
    renderView([uncertainCreate()], { port })
    fireEvent.change(idField(), { target: { value: '4711' } })
    fireEvent.click(confirmBox())

    fireEvent.click(reconcileButton())

    expect((await screen.findByRole('alert')).textContent).toContain('keep this outcome uncertain')
  })
})

describe('an archived conversation', () => {
  it('shows the deliveries but cannot act on them', () => {
    renderView([failedChange(), uncertainCreate()], { disabled: true })

    expect((screen.getByRole('button', { name: label('retry') }) as HTMLButtonElement).disabled).toBe(true)
    expect(idField().disabled).toBe(true)
    expect(confirmBox().disabled).toBe(true)
    expect(reconcileButton().disabled).toBe(true)
  })
})
