// Exposes the Sentry IPC channel to the renderer so the renderer SDK can use
// Classic IPC mode instead of the custom `sentry-ipc:` protocol scheme.
// Side-effect import only.
import '@sentry/electron/preload'
import { contextBridge, ipcRenderer } from 'electron'
import {
  configureDesktopPreloadRuntime,
} from '@bitsentry-ce/core/features/desktop/desktop-preload-runtime'

const bridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  invoke: ipcRenderer.invoke.bind(ipcRenderer),
  on: ipcRenderer.on.bind(ipcRenderer),
  removeListener: ipcRenderer.removeListener.bind(ipcRenderer),
  send: ipcRenderer.send.bind(ipcRenderer),
  exposeInMainWorld: contextBridge.exposeInMainWorld.bind(contextBridge),
}

export const bitsentryApi = configureDesktopPreloadRuntime({
  bridge,
  managedLlm: false,
})

export type BitsentryAPI = typeof bitsentryApi
