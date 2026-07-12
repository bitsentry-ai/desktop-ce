import { getDesktopEditionIdentity, type DesktopEdition } from '@bitsentry-ce/core/features/desktop/desktop-edition-identity'
import {
  getRuntimeUserDataPath as getSharedRuntimeUserDataPath,
  setRuntimeUserDataPath,
} from './runtime-paths.js'

export function createDesktopEditionRuntimePaths(edition: DesktopEdition) {
  const appDataName = getDesktopEditionIdentity(edition).appDataName

  return {
    DESKTOP_APP_DATA_NAME: appDataName,
    setRuntimeUserDataPath,
    getRuntimeUserDataPath(): string {
      return getSharedRuntimeUserDataPath(appDataName)
    },
  }
}
