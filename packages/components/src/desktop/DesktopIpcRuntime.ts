import { createTRPCUntypedClient } from '@trpc/client'
import { ipcLink } from 'electron-trpc/renderer'
import { configureDesktopIpcClientRuntime } from '../services'
import { captureDesktopAnalyticsEvent } from './DesktopPosthogRenderer'

const trpcClient = createTRPCUntypedClient({
  links: [ipcLink()],
})

export const { ipcInvoke } = configureDesktopIpcClientRuntime({
  captureDesktopAnalyticsEvent,
  invokeMutation: (channel, payload) => trpcClient.mutation(channel, payload),
})
