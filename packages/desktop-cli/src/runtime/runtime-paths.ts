import os from 'os'
import path from 'path'
import { tryGetElectronApp } from './electron-app.js'

export const DESKTOP_APP_DATA_NAME = 'SuperTerminal CE'

let userDataPathOverride = normalizeOverride(process.env.BITSENTRY_USER_DATA_DIR)
let runtimeDefaultAppDataName = DESKTOP_APP_DATA_NAME

function normalizeOverride(value: string | null | undefined): string | null {
  if (value == null) {
    return null
  }

  const normalized = value.trim()
  if (normalized === '') {
    return null
  }

  return path.resolve(normalized)
}

function getMacConfigRoot(): string {
  return path.join(os.homedir(), 'Library', 'Application Support')
}

function getWindowsConfigRoot(): string {
  const appData = process.env.APPDATA?.trim()
  if (appData !== undefined && appData !== '') {
    return appData
  }

  return path.join(os.homedir(), 'AppData', 'Roaming')
}

function getLinuxConfigRoot(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
  if (configHome !== undefined && configHome !== '') {
    return configHome
  }

  return path.join(os.homedir(), '.config')
}

const platformConfigRootResolvers: Partial<Record<NodeJS.Platform, () => string>> = {
  darwin: getMacConfigRoot,
  win32: getWindowsConfigRoot,
}

function getPlatformConfigRoot(): string {
  const resolver = platformConfigRootResolvers[process.platform]
  if (resolver !== undefined) {
    return resolver()
  }

  return getLinuxConfigRoot()
}

export function setRuntimeUserDataPath(userDataPath: string | null | undefined): void {
  userDataPathOverride = normalizeOverride(userDataPath)
}

export function setRuntimeDefaultAppDataName(appDataName: string): void {
  const normalized = appDataName.trim()
  if (normalized === '') {
    runtimeDefaultAppDataName = DESKTOP_APP_DATA_NAME
    return
  }

  runtimeDefaultAppDataName = normalized
}

export function getRuntimeUserDataPath(
  defaultAppDataName = runtimeDefaultAppDataName,
): string {
  if (userDataPathOverride !== null) {
    return userDataPathOverride
  }

  const electronApp = tryGetElectronApp()
  if (electronApp !== null) {
    return electronApp.getPath('userData')
  }

  return path.join(getPlatformConfigRoot(), defaultAppDataName)
}
