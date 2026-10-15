import { describe, expect, it, vi } from 'vitest'
import {
  customerReportProvenance, formatCustomerReportMessage, parseCustomerReportMessage,
  REFUSED_BEFORE_WRITE, zonedLocalToIso, type CustomerReport, type CustomerReportInput, type CustomerReportStore,
} from '../src/features/plugins/customer-reports'
import { IntegrationOperationService, type IntegrationWriteRuntime } from '../src/features/plugins/integration-operations'
import { StoredIntegrationOperations } from '../src/features/plugins/integration-operation-store'
import type { DesktopPluginStoredAuthRecord } from '../src/features/plugins/desktop-plugin-auth-store'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'

const report: CustomerReport = {
  id: '33333333-3333-4333-8333-333333333333', threadId: 'thread', clientRequestId: '44444444-4444-4444-8444-444444444444',
  channel: 'whatsapp', sender: 'Budi – IT PT X', receivedAt: '2026-10-15T09:12:00+07:00', timeZone: 'Asia/Jakarta',
  reportText: 'Portal HR timeout sejak jam 9.', submittedBy: 'wira', operationId: null, createdAt: '2026-10-15T02:13:00.000Z',
}

describe('customer report content', () => {
  it('builds the same private-log entry on every retry and labels the source as unverified', () => {
    const first = customerReportProvenance(report)
    expect(customerReportProvenance({ ...report })).toBe(first)
    expect(first).toContain('engineer-provided, not verified by BitSentry')
    expect(first).toContain('Channel: WhatsApp')
    expect(first).toContain('Received: 2026-10-15T09:12:00+07:00 (Asia/Jakarta)')
    expect(first).toContain(report.reportText)
    expect(first.endsWith(`bitsentry-customer-report:${report.id}`)).toBe(true)
  })

  it('round-trips the chat header and keeps the report text verbatim', () => {
    const text = formatCustomerReportMessage({ ...report, reportText: 'line one\n  line two\n' })
    expect(parseCustomerReportMessage(text)).toEqual({
      header: { id: report.id, channel: 'whatsapp', sender: report.sender, receivedAt: report.receivedAt, timeZone: 'Asia/Jakarta' },
      body: 'line one\n  line two\n',
    })
    expect(parseCustomerReportMessage('plain message')).toBeNull()
    expect(parseCustomerReportMessage('[customer-report]{"id":"not-a-uuid"}\ntext')).toBeNull()
  })

  it('converts a wall-clock time in a time zone to ISO with that zone offset', () => {
    expect(zonedLocalToIso('2026-10-15T09:12', 'Asia/Jakarta')).toBe('2026-10-15T09:12:00+07:00')
    expect(zonedLocalToIso('2026-01-15T09:12', 'America/New_York')).toBe('2026-01-15T09:12:00-05:00')
    expect(zonedLocalToIso('2026-07-15T09:12', 'America/New_York')).toBe('2026-07-15T09:12:00-04:00')
    expect(zonedLocalToIso('2026-10-15T09:12', 'Not/AZone')).toBeNull()
    expect(zonedLocalToIso('', 'UTC')).toBeNull()
  })
})

function memoryOperations() {
  const records = new Map<string, DesktopPluginStoredAuthRecord>()
  return new StoredIntegrationOperations({ get: async (id) => records.get(id) ?? {}, set: async (id, value) => { records.set(id, value); return value }, clear: async (id) => { records.delete(id) } })
}

function memoryReports(rows: CustomerReport[]): CustomerReportStore & { rows: CustomerReport[] } {
  return {
    rows,
    save: async (input: CustomerReportInput, submittedBy: string) => {
      const existing = rows.find((row) => row.threadId === input.threadId && row.clientRequestId === input.clientRequestId)
      if (existing) return existing
      const row = { ...input, id: crypto.randomUUID(), submittedBy, operationId: null, createdAt: new Date().toISOString() }
      rows.push(row)
      return row
    },
    get: async (threadId, id) => rows.find((row) => row.threadId === threadId && row.id === id) ?? null,
    link: async (threadId, id, expected, operationId) => {
      const row = rows.find((item) => item.threadId === threadId && item.id === id)
      if (!row || row.operationId !== expected) return false
      row.operationId = operationId
      return true
    },
  }
}

const itopId = '22222222-2222-4222-8222-222222222222'
function setup(executeResult: () => Promise<unknown> = async () => ({ ok: true, status: 200, data: { code: 0, objects: { 'UserRequest::7': { code: 0, key: 7, fields: { ref: 'R-000007' } } } } })) {
  const mapping = itopTicketMappingSchema.parse({
    className: 'UserRequest', fields: { title: 'title', description: 'description' },
    requiredFields: { create: [], acknowledge: [], assign: [], internal_log: [], public_log: [], resolve: [], close: [] }, stimuli: {},
  })
  const field = (key: string) => ({ key, label: key, type: key === 'fields' ? 'json' as const : 'string' as const, required: key === 'class' })
  const writes: unknown[] = []
  const runtime = {
    connection: { id: itopId, name: 'Itop Bitsentry', pluginId: 'itop', target: 'https://itop.example', enabled: true, authMode: 'token', availability: 'configured', actions: [], ticketMapping: mapping, revision: '1' },
    plugin: { id: 'itop', name: 'iTop', version: '1.0.0', description: 'Tickets', type: 'data_source', auth: { fields: [] }, actions: [{ id: 'create_object', title: 'Create', description: 'Create', riskLevel: 'write', fields: ['class', 'fields', 'outputFields', 'comment'].map(field) }] },
    execute: vi.fn(async (request: unknown) => { writes.push(request); return executeResult() }),
    read: vi.fn(),
  } as unknown as IntegrationWriteRuntime
  const reports = memoryReports([{ ...report }])
  const service = new IntegrationOperationService(memoryOperations(), async () => runtime, reports)
  const createInput = (title = 'HR portal timeout') => ({ class: 'UserRequest', fields: { title, private_log: { add_item: { message: customerReportProvenance(reports.rows[0]), format: 'text' } } }, outputFields: '*' })
  const propose = (title?: string) => service.propose('thread', { connectionId: itopId, actionId: 'create_object', input: createInput(title) }, { ticketOperation: 'create', customerReportId: report.id })
  return { service, reports, propose, writes, runtime }
}

describe('a ticket create that carries a customer report', () => {
  it('records the source on the proposal and links the report to it', async () => {
    const { propose, reports } = setup()
    const proposal = await propose()
    expect(proposal.customerReport).toEqual({ id: report.id, channel: 'whatsapp', sender: report.sender, receivedAt: report.receivedAt, timeZone: 'Asia/Jakarta', submittedBy: 'wira' })
    expect(proposal.publicUpdate).toBe(false)
    expect(reports.rows[0].operationId).toBe(proposal.id)
    expect((await propose()).id).toBe(proposal.id)
  })

  it('refuses a second, different proposal while the first waits for approval', async () => {
    const { propose } = setup()
    await propose()
    await expect(propose('Another title')).rejects.toMatchObject({ code: 'CUSTOMER_REPORT_PENDING' })
  })

  it('returns the created ticket instead of creating another one', async () => {
    const { service, propose, writes } = setup()
    const first = await propose()
    await service.approve('thread', first.id, false)
    expect((await propose('Another title')).id).toBe(first.id)
    expect(writes).toHaveLength(1)
  })

  it('refuses a new create after a timeout until the engineer confirms nothing was applied', async () => {
    const { service, propose } = setup(async () => { throw new Error('socket timeout') })
    const first = await propose()
    expect((await service.approve('thread', first.id, false)).status).toBe('uncertain')
    await expect(propose('Another title')).rejects.toMatchObject({ code: 'CUSTOMER_REPORT_UNRESOLVED' })
    await service.reconcile('thread', first.id, false, true)
    const next = await propose('Another title')
    expect(next.id).not.toBe(first.id)
    expect(next.status).toBe('proposed')
  })

  it('allows a new create after iTop refused before writing', async () => {
    const { service, propose } = setup(async () => ({ ok: false, status: 502, summary: '', data: { code: 1 } }))
    const first = await propose()
    expect(await service.approve('thread', first.id, false)).toMatchObject({ status: 'failed', message: REFUSED_BEFORE_WRITE })
    expect((await propose('Another title')).status).toBe('proposed')
  })

  it('keeps a create uncertain when only a gateway answered 403, so no second ticket can be proposed', async () => {
    const { service, propose } = setup(async () => ({ ok: false, status: 403, summary: 'Forbidden' }))
    const first = await propose()
    expect((await service.approve('thread', first.id, false)).status).toBe('uncertain')
    await expect(propose('Another title')).rejects.toMatchObject({ code: 'CUSTOMER_REPORT_UNRESOLVED' })
  })

  it('allows a new proposal after the engineer rejected the first one', async () => {
    const { service, propose } = setup()
    const first = await propose()
    await service.cancel('thread', first.id)
    const next = await propose('Another title')
    expect(next).toMatchObject({ status: 'proposed', customerReport: { id: report.id } })
    expect(next.id).not.toBe(first.id)
  })

  it('refuses a report that is not in the conversation or not in the private log', async () => {
    const { service, reports } = setup()
    await expect(service.propose('other-thread', { connectionId: itopId, actionId: 'create_object', input: { class: 'UserRequest', fields: { title: 'x' } } }, { ticketOperation: 'create', customerReportId: report.id })).rejects.toMatchObject({ code: 'CUSTOMER_REPORT_NOT_FOUND' })
    await expect(service.propose('thread', { connectionId: itopId, actionId: 'create_object', input: { class: 'UserRequest', fields: { title: 'x', private_log: { add_item: { message: 'edited', format: 'text' } } } } }, { ticketOperation: 'create', customerReportId: report.id })).rejects.toThrow('unchanged in the private log')
    await expect(service.propose('thread', { connectionId: itopId, actionId: 'create_object', input: { class: 'UserRequest', fields: { title: 'x', public_log: { add_item: { message: customerReportProvenance(reports.rows[0]), format: 'text' } } } } }, { ticketOperation: 'create', customerReportId: report.id })).rejects.toThrow('public log')
  })
})
