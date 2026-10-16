import { describe, expect, it } from 'vitest'
import { itopTicketMappingSchema } from '../src/features/plugins/itop-ticket-mapping'
import { extractIntegrationResources } from '../src/features/plugins/integration-resources'
import { ticketDeadlineStatus } from '../src/features/plugins/ticket-deadlines'

const base = {
  className: 'UserRequest',
  fields: { team: 'team_id', agent: 'agent_id' },
  requiredFields: { create: [], acknowledge: [], assign: ['team', 'agent'], internal_log: [], public_log: [], resolve: [], close: [] },
  stimuli: { assign: { stimulus: 'ev_assign', from: ['new'] } },
}
const deadlines = {
  timeZone: 'Asia/Jakarta',
  l1: { startField: 'start_date', metField: 'assignment_date', targets: { '1': 10, '2': 15 } },
  l2: { startField: 'assignment_date', metStates: ['pending', 'resolved', 'closed'], targets: { '1': 15, '2': 30 } },
}
const connection = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Itop', pluginId: 'itop' as const, target: 'https://itop.example',
  ticketMapping: itopTicketMappingSchema.parse({ ...base, deadlines }),
}

/** The card a read of this iTop ticket leaves behind. iTop times are Jakarta wall-clock time (UTC+7). */
function card(fields: Record<string, unknown>, ticketConnection: Pick<typeof connection, 'id' | 'name' | 'pluginId' | 'target' | 'ticketMapping'> = connection) {
  const [row] = extractIntegrationResources('thread', ticketConnection, { objects: { 'UserRequest::7': { class: 'UserRequest', key: '7', fields: { ref: 'R-7', title: 'VPN down', ...fields } } } })
  return row!
}
/** A moment on 2026-10-15 in Jakarta. */
const at = (time: string) => Date.parse(`2026-10-15T${time}:00+07:00`)

describe('L1 response and L2 acknowledgement deadlines of a linked ticket', () => {
  const opened = { status: 'new', priority: '2', start_date: '2026-10-15 09:00:00', assignment_date: '' }

  it('counts down the L1 response from when the ticket was opened, and reports it overdue after the target', () => {
    const row = card(opened)

    expect(ticketDeadlineStatus(row.state, at('09:10'))).toEqual({
      priority: '2',
      l1: { kind: 'pending', targetMinutes: 15, dueAt: '2026-10-15T02:15:00.000Z', minutesLeft: 5 },
      l2: { kind: 'not_started' },
    })
    expect(ticketDeadlineStatus(row.state, at('09:21'))?.l1).toEqual({ kind: 'overdue', targetMinutes: 15, dueAt: '2026-10-15T02:15:00.000Z', minutesOverdue: 6 })
  })

  it('meets L1 on assignment and starts the L2 acknowledgement clock there', () => {
    const row = card({ ...opened, status: 'assigned', assignment_date: '2026-10-15 09:12:00' })

    expect(ticketDeadlineStatus(row.state, at('09:20'))).toEqual({
      priority: '2',
      l1: { kind: 'met', targetMinutes: 15, dueAt: '2026-10-15T02:15:00.000Z', metAt: '2026-10-15T02:12:00.000Z', late: false },
      l2: { kind: 'pending', targetMinutes: 30, dueAt: '2026-10-15T02:42:00.000Z', minutesLeft: 22 },
    })
  })

  it('marks an assignment after the L1 target as met late', () => {
    const row = card({ ...opened, status: 'assigned', assignment_date: '2026-10-15 09:20:00' })

    expect(ticketDeadlineStatus(row.state, at('09:21'))?.l1).toMatchObject({ kind: 'met', late: true })
  })

  it('meets L2 once the ticket reaches an acknowledged state, without claiming it was on time', () => {
    const row = card({ ...opened, status: 'pending', assignment_date: '2026-10-15 09:12:00' })

    // Nothing records when the ticket reached the state, so whether it was late is unknown.
    expect(ticketDeadlineStatus(row.state, at('10:30'))?.l2).toEqual({ kind: 'met', targetMinutes: 30, dueAt: '2026-10-15T02:42:00.000Z', metAt: null, late: null })
  })

  it('shows no deadline for a priority without a target and never guesses one', () => {
    expect(ticketDeadlineStatus(card({ ...opened, priority: '4' }).state, at('09:10'))).toEqual({
      priority: '4', l1: { kind: 'no_target', priority: '4' }, l2: { kind: 'not_started' },
    })
    expect(ticketDeadlineStatus(card({ ...opened, priority: '' }).state, at('09:10'))?.l1).toEqual({ kind: 'no_target', priority: null })
  })

  it('reads iTop times in the configured server zone', () => {
    const utc = { ...connection, ticketMapping: itopTicketMappingSchema.parse({ ...base, deadlines: { ...deadlines, timeZone: 'UTC' } }) }

    expect(ticketDeadlineStatus(card(opened, utc).state, at('09:10'))?.l1).toMatchObject({ dueAt: '2026-10-15T09:15:00.000Z' })
  })

  it('tracks nothing on a connection without deadlines', () => {
    const plain = { ...connection, ticketMapping: itopTicketMappingSchema.parse(base) }

    expect(ticketDeadlineStatus(card(opened, plain).state, at('09:10'))).toBeNull()
  })

  it('refuses a deadline configuration that cannot say when a deadline is met, or names an unknown zone', () => {
    expect(itopTicketMappingSchema.safeParse({ ...base, deadlines: { ...deadlines, l2: { startField: 'assignment_date', targets: {} } } }).success).toBe(false)
    expect(itopTicketMappingSchema.safeParse({ ...base, deadlines: { ...deadlines, timeZone: 'Mars/Olympus' } }).success).toBe(false)
  })
})
