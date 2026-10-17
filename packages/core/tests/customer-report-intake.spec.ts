import { describe, expect, it } from 'vitest'
import {
  CustomerReportIntakeService,
  customerReportProvenance,
  type CustomerReport,
  type CustomerReportInput,
  type CustomerReportIntake,
  type CustomerReportIntakeStart,
  type CustomerReportIntakeStore,
  type CustomerReportStore,
} from '../src/features/plugins'
import { executeHostTool, type HostToolContext } from '../src/features/agent-runtime/host-tools'
import type { RunbookGateway } from '../src/features/runbooks/runbook.gateway'

const THREAD = 'thread-1'
const NOW = new Date('2026-10-17T02:00:00.000Z')

function memoryIntakes(): CustomerReportIntakeStore {
  const rows = new Map<string, CustomerReportIntake>()
  return {
    latest: async (threadId) => [...rows.values()].filter((row) => row.threadId === threadId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
    get: async (threadId, id) => { const row = rows.get(id); return row?.threadId === threadId ? row : null },
    save: async (intake) => { rows.set(intake.id, structuredClone(intake)); return intake },
  }
}

function memoryReports(): CustomerReportStore & { rows: CustomerReport[] } {
  const rows: CustomerReport[] = []
  return {
    rows,
    save: async (input: CustomerReportInput, submittedBy: string) => {
      const existing = rows.find((row) => row.threadId === input.threadId && row.clientRequestId === input.clientRequestId)
      if (existing) return existing
      const row = { ...input, id: crypto.randomUUID(), submittedBy, operationId: null, supersededById: null, createdAt: NOW.toISOString() }
      rows.push(row)
      return row
    },
    get: async (threadId, id) => rows.find((row) => row.threadId === threadId && row.id === id) ?? null,
    link: async () => true,
    supersede: async (threadId, id, supersededById) => {
      const row = rows.find((item) => item.threadId === threadId && item.id === id)
      if (row) row.supersededById = supersededById
    },
  }
}

/** The engineer's side: a conversation, an intake service, and the agent tool reading the same store. */
function conversation(messages: string[] = []) {
  let clock = 0
  const reports = memoryReports()
  const intakes = memoryIntakes()
  // Each step happens a second after the last, so the newest intake is the latest.
  const now = () => {
    clock += 1000
    return new Date(NOW.getTime() + clock)
  }
  const service = new CustomerReportIntakeService(intakes, reports, { now })
  const context = {
    gateway: {} as RunbookGateway,
    session: { id: 'session-1' },
    customerReportIntake: { start: (start: CustomerReportIntakeStart) => service.start(THREAD, { start, timeZone: 'Asia/Makassar', engineerMessages: messages }) },
  } satisfies HostToolContext
  const tool = async (args: unknown) => {
    const result = await executeHostTool(context, 'request_customer_report_input', args)
    return JSON.parse(result?.output ?? result?.error ?? '{}') as { status: string; intakeId?: string; question?: { field: string }; known?: Record<string, unknown>; customerReportId?: string; code?: string }
  }
  const answer = async (intakeId: string, value: { field: string; value: unknown }, clientRequestId: string = crypto.randomUUID()) =>
    await service.answer({ threadId: THREAD, intakeId, clientRequestId, answer: value as never }, 'wira')
  return { messages, service, intakes, reports, tool, answer, say: (text: string) => { messages.push(text) } }
}

describe('customer report intake in chat', () => {
  it('asks only what the chat does not say: a relayed email with a named sender asks the subject next', async () => {
    const chat = conversation(['Pak Budi barusan email, katanya VPN kantor putus terus dari pagi.'])
    const started = await chat.tool({ origin: 'customer', extracted: [
      { field: 'channel', value: 'email', quote: 'barusan email' },
      { field: 'sender', value: 'Pak Budi', quote: 'Pak Budi' },
    ] })
    expect(started).toMatchObject({ status: 'asking', question: { field: 'subject' }, known: { channel: 'email', sender: 'Pak Budi' } })
  })

  it('offers the message the report came from as "Use what I wrote", not a later remark', async () => {
    const chat = conversation(['Pak Budi barusan WA, katanya VPN kantor putus terus dari pagi.', 'tolong dicek cepat ya'])
    await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Pak Budi', quote: 'Pak Budi' }] })
    expect((await chat.service.latest(THREAD))?.relayedText).toBe('Pak Budi barusan WA, katanya VPN kantor putus terus dari pagi.')
  })

  it('drops a value whose words are not in the conversation, so it is asked instead of guessed', async () => {
    const chat = conversation(['A customer called, the portal is down since 9.'])
    const started = await chat.tool({ origin: 'customer', extracted: [
      { field: 'channel', value: 'phone', quote: 'customer called' },
      { field: 'sender', value: 'Rina', quote: 'Rina from Acme' },
      { field: 'receivedAt', value: '2026-10-18T09:00:00+08:00', quote: 'since 9' },
    ] })
    expect(started).toMatchObject({ status: 'asking', question: { field: 'sender' }, known: { channel: 'phone' } })
    expect(started.known).not.toHaveProperty('sender')
    expect(started.known).not.toHaveProperty('receivedAt')
  })

  it('collects one answer at a time and saves "not sure" as not provided, never as a guess', async () => {
    const chat = conversation(['We just got a customer report by email: the service desk keeps loading.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'channel', value: 'email', quote: 'by email' }] })
    const intakeId = started.intakeId ?? ''
    expect((await chat.answer(intakeId, { field: 'sender', value: null })).intake.question).toBe('subject')
    expect((await chat.answer(intakeId, { field: 'subject', value: 'Service desk timeout' })).intake.question).toBe('receivedAt')
    expect((await chat.answer(intakeId, { field: 'receivedAt', value: null })).intake.question).toBe('reportText')
    const done = await chat.answer(intakeId, { field: 'reportText', value: 'The service desk keeps loading and times out.' })

    expect(done.intake).toMatchObject({ status: 'saved', question: null, customerReportId: done.report?.id })
    expect(done.report).toMatchObject({ channel: 'email', sender: null, receivedAt: null, subject: 'Service desk timeout', reportText: 'The service desk keeps loading and times out.', intakeId })
    const log = customerReportProvenance(done.report as CustomerReport)
    expect(log).toContain('Sender: not provided')
    expect(log).toContain('Received: not provided')
    expect(log).toContain('Subject: Service desk timeout')
  })

  it('asks whether a pasted message is from a customer, and keeps the pasted text as the report', async () => {
    const pasted = 'Selamat pagi, saya tidak bisa membuka service desk dari tadi pagi. Mohon dibantu.'
    const chat = conversation([pasted])
    const started = await chat.tool({ origin: 'unsure' })
    expect(started).toMatchObject({ status: 'asking', question: { field: 'origin' } })
    const yes = await chat.answer(started.intakeId ?? '', { field: 'origin', value: true })
    expect(yes.intake).toMatchObject({ question: 'channel', answers: { reportText: pasted } })
  })

  it('never asks again after the engineer says a pasted message is not from a customer', async () => {
    const chat = conversation(['Halo, saya tidak bisa login. Mohon dibantu.'])
    const started = await chat.tool({ origin: 'unsure' })
    await chat.answer(started.intakeId ?? '', { field: 'origin', value: false })
    chat.say('Halo, masih tidak bisa login. Tolong.')
    expect(await chat.tool({ origin: 'unsure' })).toMatchObject({ status: 'dismissed', intakeId: started.intakeId })
  })

  it('keeps a dismissed report closed, also for a later message about the same customer; a different named customer starts a new one', async () => {
    const chat = conversation(['Pak Budi barusan WA, katanya VPN kantor putus terus dari pagi.'])
    const first = await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Pak Budi', quote: 'Pak Budi' }, { field: 'channel', value: 'whatsapp', quote: 'barusan WA' }] })
    await chat.service.dismiss({ threadId: THREAD, intakeId: first.intakeId ?? '' })

    chat.say('Pak Budi WA lagi, katanya masih putus')
    expect(await chat.tool({ origin: 'customer', newReport: true, extracted: [{ field: 'sender', value: 'Pak Budi', quote: 'Pak Budi' }] })).toMatchObject({ status: 'dismissed' })
    expect(await chat.tool({ origin: 'customer' })).toMatchObject({ status: 'dismissed' })

    chat.say('Rina from Acme called, she cannot log in to the portal.')
    const second = await chat.tool({ origin: 'customer', newReport: true, extracted: [{ field: 'sender', value: 'Rina', quote: 'Rina from Acme' }, { field: 'channel', value: 'phone', quote: 'called' }] })
    expect(second).toMatchObject({ status: 'asking', question: { field: 'receivedAt' } })
    expect(second.intakeId).not.toBe(first.intakeId)
  })

  it('applies a retried answer once', async () => {
    const chat = conversation(['Rina from Acme called, she cannot log in to the portal.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Rina', quote: 'Rina from Acme' }, { field: 'channel', value: 'phone', quote: 'called' }] })
    await chat.answer(started.intakeId ?? '', { field: 'receivedAt', value: '2026-10-17T09:30:00+08:00' })
    const request = crypto.randomUUID()
    const first = await chat.answer(started.intakeId ?? '', { field: 'reportText', value: 'Cannot log in to the portal.' }, request)
    const retry = await chat.answer(started.intakeId ?? '', { field: 'reportText', value: 'Cannot log in to the portal.' }, request)
    expect(retry.report?.id).toBe(first.report?.id)
    expect(chat.reports.rows).toHaveLength(1)
  })

  it('refuses a received time in the future', async () => {
    const chat = conversation(['Rina from Acme called, she cannot log in to the portal.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Rina', quote: 'Rina from Acme' }, { field: 'channel', value: 'phone', quote: 'called' }] })
    await expect(chat.answer(started.intakeId ?? '', { field: 'receivedAt', value: '2026-10-18T09:30:00+08:00' })).rejects.toMatchObject({ code: 'INTAKE_TIME_IN_FUTURE' })
  })
})

describe('a forwarded customer email in chat', () => {
  const prompt = 'Please collect this forwarded customer email here only; do not create a ticket or change external systems.\nFrom: Rina from Acme\nSubject: Service desk timeout\nDate: 17 October 2026, 09:15 WITA (UTC+08:00)\n\nHi team, our service desk page keeps loading and then times out. Two colleagues have the same problem.'
  const body = 'Hi team, our service desk page keeps loading and then times out. Two colleagues have the same problem.'

  it('asks only to confirm when the email gives every value, and saves the customer\'s words without the engineer\'s instructions or headers', async () => {
    const chat = conversation([prompt])
    const started = await chat.tool({ origin: 'customer', extracted: [
      { field: 'channel', value: 'email', quote: 'forwarded customer email' },
      { field: 'sender', value: 'Rina from Acme', quote: 'From: Rina from Acme' },
      { field: 'subject', value: 'Service desk timeout', quote: 'Subject: Service desk timeout' },
      { field: 'receivedAt', value: '2026-10-17T09:15:00+08:00', quote: '17 October 2026, 09:15 WITA (UTC+08:00)' },
      { field: 'reportText', value: body, quote: body },
    ] })
    expect(started).toMatchObject({ status: 'asking', question: { field: 'confirm' } })

    const saved = await chat.answer(started.intakeId ?? '', { field: 'confirm', value: true })
    expect(saved.report).toMatchObject({ channel: 'email', sender: 'Rina from Acme', subject: 'Service desk timeout', receivedAt: '2026-10-17T09:15:00+08:00', reportText: body })
  })

  it('keeps the engineer\'s instructions out of the customer\'s words: report text not in the message is asked instead', async () => {
    const chat = conversation([prompt])
    const started = await chat.tool({ origin: 'customer', extracted: [
      { field: 'channel', value: 'email', quote: 'forwarded customer email' },
      { field: 'reportText', value: 'The service desk is down for everyone.', quote: 'The service desk is down for everyone.' },
    ] })
    expect(started.known).not.toHaveProperty('reportText')
  })

  it('never takes a subject from the complaint itself', async () => {
    const chat = conversation(['We just got a customer report by email: the service desk keeps loading and times out for them.'])
    const started = await chat.tool({ origin: 'customer', extracted: [
      { field: 'channel', value: 'email', quote: 'by email' },
      { field: 'sender', value: 'customer', quote: 'customer report' },
      { field: 'subject', value: 'the service desk keeps loading', quote: 'the service desk keeps loading' },
    ] })
    expect(started).toMatchObject({ question: { field: 'subject' } })
  })

  it('saves a typed received time with the zone the engineer typed it in', async () => {
    const chat = conversation(['Rina from Acme called, she cannot log in to the portal.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Rina', quote: 'Rina from Acme' }, { field: 'channel', value: 'phone', quote: 'called' }] })
    await chat.answer(started.intakeId ?? '', { field: 'receivedAt', value: '2026-10-17T09:30:00+08:00', timeZone: 'Asia/Makassar' })
    const saved = await chat.answer(started.intakeId ?? '', { field: 'reportText', value: 'Cannot log in.' })
    expect(saved.report).toMatchObject({ receivedAt: '2026-10-17T09:30:00+08:00', timeZone: 'Asia/Makassar' })
  })
})

describe('correcting a customer report', () => {
  async function savedEmailReport() {
    const chat = conversation(['We just got a customer report by email: the service desk keeps loading.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'channel', value: 'email', quote: 'by email' }] })
    const intakeId = started.intakeId ?? ''
    await chat.answer(intakeId, { field: 'sender', value: 'Dewi' })
    await chat.answer(intakeId, { field: 'subject', value: 'Service desk timeout' })
    await chat.answer(intakeId, { field: 'receivedAt', value: null })
    const saved = await chat.answer(intakeId, { field: 'reportText', value: 'Service desk keeps loading.' })
    return { chat, intakeId, saved: saved.report as CustomerReport }
  }

  it('changes one earlier answer during the intake and goes back to the open question', async () => {
    const chat = conversation(['We just got a customer report by email: the service desk keeps loading.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'channel', value: 'email', quote: 'by email' }] })
    const intakeId = started.intakeId ?? ''
    await chat.answer(intakeId, { field: 'sender', value: null })
    const changed = await chat.answer(intakeId, { field: 'sender', value: 'Dewi' })
    expect(changed.intake).toMatchObject({ question: 'subject', answers: { sender: 'Dewi' } })
  })

  it('saves a corrected version after the report is saved; the earlier version can no longer be used for a ticket', async () => {
    const { chat, intakeId, saved } = await savedEmailReport()
    const corrected = await chat.answer(intakeId, { field: 'channel', value: 'whatsapp' })

    expect(corrected.report).toMatchObject({ channel: 'whatsapp', sender: 'Dewi', reportText: 'Service desk keeps loading.' })
    expect(corrected.report).not.toHaveProperty('subject')
    expect(corrected.intake).toMatchObject({ status: 'saved', customerReportId: corrected.report?.id })
    expect(await chat.reports.get(THREAD, saved.id)).toMatchObject({ channel: 'email', supersededById: corrected.report?.id })
  })

  it('asks only the subject when a saved report is changed to email; closing that question keeps the saved report', async () => {
    const chat = conversation(['Rina from Acme called, she cannot log in to the portal.'])
    const started = await chat.tool({ origin: 'customer', extracted: [{ field: 'sender', value: 'Rina', quote: 'Rina from Acme' }, { field: 'channel', value: 'phone', quote: 'called' }] })
    const intakeId = started.intakeId ?? ''
    await chat.answer(intakeId, { field: 'receivedAt', value: null })
    const saved = await chat.answer(intakeId, { field: 'reportText', value: 'Cannot log in to the portal.' })

    const toEmail = await chat.answer(intakeId, { field: 'channel', value: 'email' })
    expect(toEmail.intake).toMatchObject({ status: 'open', question: 'subject' })
    const closed = await chat.service.dismiss({ threadId: THREAD, intakeId })
    expect(closed).toMatchObject({ status: 'saved', customerReportId: saved.report?.id, answers: { channel: 'phone' } })
    expect(chat.reports.rows).toHaveLength(1)
  })

  it('refuses a correction once a ticket uses the report', async () => {
    const { chat, intakeId, saved } = await savedEmailReport()
    saved.operationId = 'operation-1'
    // The same stores, now with the ticket create the report points to.
    const service = new CustomerReportIntakeService(chat.intakes, chat.reports, { linkedOperation: async () => ({ status: 'succeeded', result: { ref: 'R-1' } }) })
    await expect(service.answer({ threadId: THREAD, intakeId, clientRequestId: crypto.randomUUID(), answer: { field: 'sender', value: 'Sari' } }, 'wira'))
      .rejects.toMatchObject({ code: 'INTAKE_REPORT_IN_USE' })
  })
})
