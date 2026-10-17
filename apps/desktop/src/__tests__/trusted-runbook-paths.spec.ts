import path from 'path'
import { describe, expect, it } from 'vitest'

import {
  approveRunbookExportPath,
  approveRunbookImportPaths,
  consumeApprovedRunbookExportPath,
  consumeApprovedRunbookImportPath,
} from '@bitsentry-ce/core/features/runbooks/desktop-trusted-runbook-paths'

describe('trusted runbook paths', () => {
  it('only allows consuming import paths that were approved by the dialog', () => {
    const filePath = path.join(process.cwd(), `tmp/import-${String(Date.now())}.json`)

    approveRunbookImportPaths(['   ', filePath])

    expect(consumeApprovedRunbookImportPath(filePath)).toBe(path.resolve(filePath))
    expect(() => consumeApprovedRunbookImportPath(filePath)).toThrow(
      'Runbook import file must be selected via the import dialog',
    )
  })

  it('tracks approved export paths separately from import paths', () => {
    const exportPath = path.join(process.cwd(), `tmp/export-${String(Date.now())}.json`)

    approveRunbookExportPath(`  ${exportPath}  `)

    expect(consumeApprovedRunbookExportPath(exportPath)).toBe(path.resolve(exportPath))
    expect(() => consumeApprovedRunbookExportPath(exportPath)).toThrow(
      'Runbook export file must be selected via the export dialog',
    )
  })
})
