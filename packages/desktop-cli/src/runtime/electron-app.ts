export type ElectronAppLike = {
  getPath(name: 'userData'): string
  getVersion(): string
}

type ElectronModuleLike = {
  app?: unknown
}

function isElectronApp(value: unknown): value is ElectronAppLike {
  if (value === null || typeof value !== 'object') {
    return false
  }

  return 'getPath' in value &&
    typeof value.getPath === 'function' &&
    'getVersion' in value &&
    typeof value.getVersion === 'function'
}

export function tryGetElectronApp(): ElectronAppLike | null {
  try {
    // `require("electron")` returns the app API inside Electron, but a plain
    // executable path string when loaded under Node. We only use the object form.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron is optional outside the desktop app.
    const electron: unknown = require('electron')
    if (electron === null || typeof electron !== 'object' || Array.isArray(electron)) {
      return null
    }

    const { app } = electron as ElectronModuleLike
    if (isElectronApp(app)) {
      return app
    }
  } catch {
    return null
  }

  return null
}

export function getRuntimeAppVersion(fallback = '0.0.0'): string {
  const electronApp = tryGetElectronApp()
  if (electronApp !== null) {
    return electronApp.getVersion()
  }

  const envVersion = process.env.npm_package_version?.trim()
  if (envVersion !== undefined && envVersion !== '') {
    return envVersion
  }

  return fallback
}
