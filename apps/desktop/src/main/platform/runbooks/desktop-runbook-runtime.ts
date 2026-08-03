import '../storage/database/seeding'
import { createDesktopEditionRunbookRuntime } from '@bitsentry-ce/desktop-cli/runtime/desktop-runbook-runtime'
import { RunbookExecutionService } from '../../features/runbooks/services/runbook-execution.service'
import { DESKTOP_APP_DATA_NAME, setRuntimeUserDataPath } from '../runtime/runtime-paths'
export { type DesktopRunbookRuntimeOptions } from '@bitsentry-ce/desktop-cli/runtime/desktop-runbook-runtime'

export const DesktopRunbookRuntime = createDesktopEditionRunbookRuntime({
  RunbookExecutionService,
  setRuntimeUserDataPath,
  defaultAppDataName: DESKTOP_APP_DATA_NAME,
})
