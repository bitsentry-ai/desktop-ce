import {
  exportRunbooksInputSchema,
  runbookImportOptionsSchema,
} from '@bitsentry-ce/core/features/runbooks/export.schemas'
import {
  logFilterConfigSchema,
  telemetryActionConfigSchema,
} from '@bitsentry-ce/core/features/runbooks/runbooks.schemas'
import {
  createDesktopEditionIpcPayloadValidator,
} from './desktop-ipc-payload-schemas'

type DesktopIpcPayloadValidatorOptions = {
  edition: 'ce' | 'pro'
  importFromFileOptionsRequired?: boolean
}

export function createDesktopAppIpcPayloadValidator({
  edition,
  importFromFileOptionsRequired,
}: DesktopIpcPayloadValidatorOptions) {
  const validatePayload = createDesktopEditionIpcPayloadValidator({
    edition,
    exportRunbooksInputSchema,
    runbookImportOptionsSchema,
    logFilterConfigSchema,
    telemetryActionConfigSchema,
    importFromFileOptionsRequired,
  })

  return validatePayload
}
