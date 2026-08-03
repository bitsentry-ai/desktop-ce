/**
 * The router is derived from the shared contract. Keep this as a runtime
 * parity check so adding a channel cannot silently omit it from electron-trpc.
 */
import {
  DESKTOP_RPC_CHANNELS,
  createDesktopTrpcRouter,
} from '@bitsentry-ce/components/services'
import { expect, it } from 'vitest'

const dispatched: string[] = []
const router = createDesktopTrpcRouter({
  dispatch: (channel) => {
    dispatched.push(channel)
    return Promise.resolve({ ok: true })
  },
})

const routerChannels = Object.keys(router._def.procedures).sort()
const contractChannels = [...DESKTOP_RPC_CHANNELS].sort()

it('registers every desktop IPC contract channel', () => {
  expect(routerChannels).toEqual(contractChannels)
  expect(dispatched).toEqual([])
})
