import { createDesktopEditionRuntimePaths } from '@bitsentry-ce/desktop-cli/runtime/desktop-runtime-paths'

const runtimePaths = createDesktopEditionRuntimePaths('ce')

export const DESKTOP_APP_DATA_NAME = runtimePaths.DESKTOP_APP_DATA_NAME
export const setRuntimeUserDataPath: typeof runtimePaths.setRuntimeUserDataPath = (
  userDataPath,
) => {
  runtimePaths.setRuntimeUserDataPath(userDataPath)
}
