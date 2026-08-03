import type { ReactNode } from 'react'
import {
  DesktopStateBootstrap as SharedDesktopStateBootstrap,
  type DesktopStateBootstrapProps,
} from './DesktopStateBootstrap'
import { ipcInvoke } from './DesktopIpcRuntime'
import { captureDesktopAnalyticsEvent } from './DesktopPosthogRenderer'

type DesktopRunbookBridge = {
  runbooks: {
    onExecutionEvent: DesktopStateBootstrapProps['subscribeToRunbookExecutionEvents']
    onChanged?: DesktopStateBootstrapProps['subscribeToRunbookChangeEvents']
  }
}

type DesktopRunbookWindow = Window & {
  bitsentry?: DesktopRunbookBridge
}

const sharedIpcInvoke: DesktopStateBootstrapProps['ipcInvoke'] = (
  channel,
  ...args
) => ipcInvoke(channel as Parameters<typeof ipcInvoke>[0], ...args)

function subscribeToRunbookExecutionEvents(
  callback: Parameters<
    DesktopStateBootstrapProps['subscribeToRunbookExecutionEvents']
  >[0],
) {
  const desktopWindow: DesktopRunbookWindow = window
  if (desktopWindow.bitsentry === undefined) {
    throw new Error('Desktop runbook bridge is unavailable.')
  }

  return desktopWindow.bitsentry.runbooks.onExecutionEvent(callback)
}

function subscribeToRunbookChangeEvents(
  callback: Parameters<
    DesktopStateBootstrapProps['subscribeToRunbookChangeEvents']
  >[0],
) {
  const desktopWindow: DesktopRunbookWindow = window
  const onChanged = desktopWindow.bitsentry?.runbooks?.onChanged
  if (typeof onChanged !== 'function') {
    console.warn(
      '[desktop-state] Runbook change bridge is unavailable; using non-destructive mirror sync only.',
    )
    return () => undefined
  }

  return onChanged(callback)
}

export function DesktopStateBootstrap({ children }: { children: ReactNode }) {
  return (
    <SharedDesktopStateBootstrap
      ipcInvoke={sharedIpcInvoke}
      captureDesktopAnalyticsEvent={captureDesktopAnalyticsEvent}
      subscribeToRunbookExecutionEvents={subscribeToRunbookExecutionEvents}
      subscribeToRunbookChangeEvents={subscribeToRunbookChangeEvents}
    >
      {children}
    </SharedDesktopStateBootstrap>
  )
}
