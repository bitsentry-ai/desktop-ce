import path from 'node:path'
import type {
  approveRunbookExportPath,
  approveRunbookImportPaths,
} from './desktop-trusted-runbook-paths'

type RpcHandler = (payload: unknown) => Promise<unknown>

type DialogFilter = {
  name: string
  extensions: string[]
}

type SaveDialogPayload = {
  defaultPath?: string
  defaultFileName?: string
  filters?: DialogFilter[]
  trustScope?: 'runbooks-export'
}

type OpenDialogPayload = {
  defaultPath?: string
  filters?: DialogFilter[]
  properties?: string[]
  trustScope?: 'runbooks-import'
}

type DialogSaveResult = {
  canceled: boolean
  filePath?: string
}

type DialogOpenResult = {
  canceled: boolean
  filePaths: string[]
}

export type DesktopDialogWindow = object | null

export interface DesktopDialogPort {
  showSaveDialog(
    window: DesktopDialogWindow,
    options: {
      defaultPath?: string
      filters?: DialogFilter[]
    },
  ): Promise<DialogSaveResult>
  showSaveDialog(options: {
    defaultPath?: string
    filters?: DialogFilter[]
  }): Promise<DialogSaveResult>
  showOpenDialog(
    window: DesktopDialogWindow,
    options: {
      defaultPath?: string
      filters?: DialogFilter[]
      properties?: string[]
    },
  ): Promise<DialogOpenResult>
  showOpenDialog(options: {
    defaultPath?: string
    filters?: DialogFilter[]
    properties?: string[]
  }): Promise<DialogOpenResult>
}

export interface DesktopDialogPathProvider {
  getPath(name: 'downloads' | 'documents' | 'home'): string
}

export interface CreateDesktopDialogHandlersOptions {
  dialog: DesktopDialogPort
  app: DesktopDialogPathProvider
  getWindow(): DesktopDialogWindow
  approveRunbookExportPath: typeof approveRunbookExportPath
  approveRunbookImportPaths: typeof approveRunbookImportPaths
}

function defaultDialogDirectory(
  app: DesktopDialogPathProvider,
): string {
  const preferredLocations: Array<'downloads' | 'documents' | 'home'> = [
    'downloads',
    'documents',
    'home',
  ]

  for (const location of preferredLocations) {
    try {
      const resolvedPath = app.getPath(location)
      if (resolvedPath.trim().length > 0) {
        return resolvedPath
      }
    } catch {
      // Electron rejects unknown locations; try the next candidate.
    }
  }

  return process.cwd()
}

function resolveSaveDefaultPath(
  app: DesktopDialogPathProvider,
  payload: SaveDialogPayload,
): string | undefined {
  const defaultPath = payload.defaultPath?.trim()
  if (defaultPath !== undefined && defaultPath.length > 0) {
    return defaultPath
  }

  const defaultFileName = payload.defaultFileName?.trim()
  if (defaultFileName !== undefined && defaultFileName.length > 0) {
    return path.join(
      defaultDialogDirectory(app),
      path.basename(defaultFileName),
    )
  }

  return undefined
}

async function showSaveDialog(
  dialog: DesktopDialogPort,
  window: DesktopDialogWindow,
  options: {
    defaultPath?: string
    filters?: DialogFilter[]
  },
): Promise<DialogSaveResult> {
  if (window !== null) {
    return dialog.showSaveDialog(window, options)
  }

  return dialog.showSaveDialog(options)
}

async function showOpenDialog(
  dialog: DesktopDialogPort,
  window: DesktopDialogWindow,
  options: {
    defaultPath?: string
    filters?: DialogFilter[]
    properties?: string[]
  },
): Promise<DialogOpenResult> {
  if (window !== null) {
    return dialog.showOpenDialog(window, options)
  }

  return dialog.showOpenDialog(options)
}

export function createDesktopDialogHandlers(
  options: CreateDesktopDialogHandlersOptions,
): Record<string, RpcHandler> {
  return {
    'dialog:showSaveDialog': async (payload: unknown) => {
      const input = (payload ?? {}) as SaveDialogPayload
      const result = await showSaveDialog(options.dialog, options.getWindow(), {
        defaultPath: resolveSaveDefaultPath(options.app, input),
        filters: input.filters,
      })

      if (
        input.trustScope === 'runbooks-export' &&
        !result.canceled &&
        typeof result.filePath === 'string'
      ) {
        options.approveRunbookExportPath(result.filePath)
      }

      let filePath: string | null = result.filePath ?? null
      if (result.canceled) {
        filePath = null
      }

      return {
        filePath,
        canceled: result.canceled,
      }
    },
    'dialog:showOpenDialog': async (payload: unknown) => {
      const input = (payload ?? {}) as OpenDialogPayload
      const defaultPath = input.defaultPath?.trim()
      let properties = ['openFile']
      if (input.properties !== undefined && input.properties.length > 0) {
        properties = input.properties
      }

      const result = await showOpenDialog(options.dialog, options.getWindow(), {
        defaultPath,
        filters: input.filters,
        properties,
      })

      if (input.trustScope === 'runbooks-import' && !result.canceled) {
        options.approveRunbookImportPaths(result.filePaths)
      }

      return {
        filePaths: result.filePaths,
        canceled: result.canceled,
      }
    },
  }
}
