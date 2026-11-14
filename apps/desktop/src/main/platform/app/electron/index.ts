import { app } from 'electron'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { getDesktopEditionIdentity } from '@bitsentry-ce/core/features/desktop/desktop-edition-identity'

// main.ts renames the app later, so the default userData folder is not the app's own folder yet.
try {
  enableCompileCache(join(app.getPath('appData'), getDesktopEditionIdentity('ce').appDataName, 'compile-cache'))
} catch {
  // Cache availability must not prevent startup.
}

// macOS can deliver a launch deep link (OAuth callback) before main.ts has
// registered its handler, so hold those URLs until it has.
const launchUrls: string[] = []
const holdLaunchUrl = (event: Electron.Event, url: string): void => {
  event.preventDefault()
  launchUrls.push(url)
}
app.on('open-url', holdLaunchUrl)

import('./main').then(() => {
  app.removeListener('open-url', holdLaunchUrl)
  for (const url of launchUrls.splice(0)) {
    app.emit('open-url', { preventDefault: () => {} }, url)
  }
}).catch((error: unknown) => {
  // Surface a failed load as an uncaught exception, as when this module loaded main directly.
  setImmediate(() => {
    throw error
  })
})
