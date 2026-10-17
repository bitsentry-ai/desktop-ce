import path from 'path'

const approvedRunbookImportPaths = new Map<string, string>()
const approvedRunbookExportPaths = new Map<string, string>()

function resolveTrustedPath(filePath: string): string {
  const trimmed = filePath.trim()
  if (path.isAbsolute(trimmed) || trimmed.startsWith('/')) {
    return trimmed
  }

  return path.resolve(trimmed)
}

function trustedPathKey(filePath: string): string {
  const normalized = path.resolve(filePath.trim())
  if (process.platform === 'win32') {
    return normalized.toLowerCase()
  }

  return normalized
}

export function approveRunbookImportPaths(filePaths: string[]): void {
  for (const filePath of filePaths) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      continue
    }

    approvedRunbookImportPaths.set(
      trustedPathKey(filePath),
      resolveTrustedPath(filePath),
    )
  }
}

export function approveRunbookExportPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return
  }

  approvedRunbookExportPaths.set(
    trustedPathKey(filePath),
    resolveTrustedPath(filePath),
  )
}

export function consumeApprovedRunbookImportPath(filePath: string): string {
  const key = trustedPathKey(filePath)
  const approvedPath = approvedRunbookImportPaths.get(key)
  if (approvedPath === undefined || approvedPath.length === 0) {
    throw new Error('Runbook import file must be selected via the import dialog')
  }

  approvedRunbookImportPaths.delete(key)
  return approvedPath
}

export function consumeApprovedRunbookExportPath(filePath: string): string {
  const key = trustedPathKey(filePath)
  const approvedPath = approvedRunbookExportPaths.get(key)
  if (approvedPath === undefined || approvedPath.length === 0) {
    throw new Error('Runbook export file must be selected via the export dialog')
  }

  approvedRunbookExportPaths.delete(key)
  return approvedPath
}
