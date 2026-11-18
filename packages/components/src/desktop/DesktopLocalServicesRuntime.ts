import {
  type DesktopIpcInvoke,
  createDesktopLocalBitsentryServices,
} from '../services/desktop-local-services'
import { ipcInvoke } from './DesktopIpcRuntime'

export const localBitsentryServices = createDesktopLocalBitsentryServices({
  ipcInvoke: ipcInvoke as DesktopIpcInvoke,
})
