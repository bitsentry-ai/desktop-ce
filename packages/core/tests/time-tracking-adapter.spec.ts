import { describe, expect, it } from 'vitest'
import { TimeTrackingAdapterRegistry, timerRequestSchema, timerResultSchema, type TimerCapabilities, type TimeTrackingAdapter } from '../src/features/plugins/time-tracking-adapter'
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

  const adapterWith = (capabilities: TimerCapabilities): TimeTrackingAdapter => ({
    id: 'custom-timer',
    capabilities: async () => capabilities,
    read: async () => ({ outcome: 'unavailable', message: 'Not used' }),
    prepare: async () => ({ kind: 'clarification', requiredFields: [], message: 'Not used' }),
    executeApproved: async () => ({ outcome: 'unavailable', message: 'Not used' }),
  })
  const configured: TimerCapabilities = { connectionId: id, availability: 'configured', actions: ['read'], remoteIdempotency: 'supported' }
  it('registers an adapter whose capabilities omit the optional adapter ID', async () => {
    const registry = new TimeTrackingAdapterRegistry()
    registry.register(id, adapterWith(configured))
    expect(await registry.capabilities(id)).toEqual(configured)
  })
  it('accepts capabilities that carry the matching adapter ID', async () => {
    const registry = new TimeTrackingAdapterRegistry()
    registry.register(id, adapterWith({ ...configured, adapterId: 'custom-timer' }))
    expect((await registry.capabilities(id)).adapterId).toBe('custom-timer')
  })
  it('rejects capabilities that name a different adapter', async () => {
    const registry = new TimeTrackingAdapterRegistry()
    registry.register(id, adapterWith({ ...configured, adapterId: 'other-timer' }))
    await expect(registry.capabilities(id)).rejects.toThrow('mismatched connection identity')
  })
  it('rejects capabilities that name a different connection', async () => {
    const registry = new TimeTrackingAdapterRegistry()
    registry.register(id, adapterWith({ ...configured, connectionId: '22222222-2222-4222-8222-222222222222' }))
    await expect(registry.capabilities(id)).rejects.toThrow('mismatched connection identity')
  })
})
