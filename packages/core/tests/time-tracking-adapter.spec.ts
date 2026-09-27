import { describe, expect, it } from 'vitest'
import { TimeTrackingAdapterRegistry, timerRequestSchema, timerResultSchema } from '../src/features/plugins/time-tracking-adapter'
const id = '11111111-1111-4111-8111-111111111111'
describe('custom timer adapter contract', () => {
  it('advertises no timer actions until a runtime adapter is connected', async () => {
    const registry = new TimeTrackingAdapterRegistry()
    expect(await registry.capabilities(id)).toEqual({ connectionId: id, availability: 'not_connected', actions: [], remoteIdempotency: 'unknown' })
    expect(registry.resolve(id)).toBeUndefined()
  })
  it('keeps uncertainty separate from measured remote success', () => {
    expect(timerResultSchema.parse({ outcome: 'uncertain', message: 'Inspect remote timer' }).outcome).toBe('uncertain')
    expect(timerResultSchema.safeParse({ outcome: 'succeeded', elapsedSeconds: -1 }).success).toBe(false)
    expect(timerRequestSchema.safeParse({ connectionId: id, ticketId: '42', action: 'start', credentials: 'secret' }).success).toBe(false)
  })
})
