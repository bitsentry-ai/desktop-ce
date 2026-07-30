import type { LocalAiProviderKey, LocalAiSettings } from './types.js'

export type CodingAgentsHandlerProvider = {
  getSettings(): LocalAiSettings
  saveSettings(patch: Partial<LocalAiSettings>): Promise<LocalAiSettings>
  probe(provider: LocalAiProviderKey): Promise<unknown>
  detect(provider: LocalAiProviderKey, preferredBinaryPath?: string): Promise<string | null>
  listModels(provider: LocalAiProviderKey): Promise<string[]>
  runDoctor(provider: LocalAiProviderKey): Promise<unknown>
}

export type CodingAgentsIpcMain = {
  handle(
    channel: string,
    listener: (_event: unknown, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

function isLocalAiProvider(value: unknown): value is LocalAiProviderKey {
  switch (value) {
    case 'claude_code':
    case 'codex':
    case 'opencode':
    case 'cursor':
      return true
    default:
      return false
  }
}

export function registerCodingAgentsHandlers(
  ipcMain: CodingAgentsIpcMain,
  localAiProvider: CodingAgentsHandlerProvider,
): void {
  ipcMain.handle('bitsentry:llm:local:getSettings', () => {
    return localAiProvider.getSettings()
  })

  ipcMain.handle('bitsentry:llm:local:saveSettings', async (_event, patch: unknown) => {
    if (patch === null || typeof patch !== 'object') {
      throw new Error('Invalid settings patch')
    }
    return localAiProvider.saveSettings(patch)
  })

  ipcMain.handle('bitsentry:llm:local:probe', async (_event, provider: unknown) => {
    if (!isLocalAiProvider(provider)) {
      throw new Error(`Invalid provider: ${String(provider)}`)
    }
    return localAiProvider.probe(provider)
  })

  ipcMain.handle('bitsentry:llm:local:detectBinary', async (_event, provider: unknown, preferredBinaryPath?: unknown) => {
    if (!isLocalAiProvider(provider)) {
      throw new Error(`Invalid provider: ${String(provider)}`)
    }
    return localAiProvider.detect(
      provider,
      resolvePreferredBinaryPath(preferredBinaryPath),
    )
  })

  ipcMain.handle('bitsentry:llm:local:listModels', async (_event, provider: unknown) => {
    if (!isLocalAiProvider(provider)) {
      throw new Error(`Invalid provider: ${String(provider)}`)
    }
    return localAiProvider.listModels(provider)
  })

  ipcMain.handle('bitsentry:llm:local:doctor', async (_event, provider: unknown) => {
    if (!isLocalAiProvider(provider)) {
      throw new Error(`Invalid provider: ${String(provider)}`)
    }
    return localAiProvider.runDoctor(provider)
  })
}

export function unregisterCodingAgentsHandlers(ipcMain: CodingAgentsIpcMain): void {
  ipcMain.removeHandler('bitsentry:llm:local:getSettings')
  ipcMain.removeHandler('bitsentry:llm:local:saveSettings')
  ipcMain.removeHandler('bitsentry:llm:local:probe')
  ipcMain.removeHandler('bitsentry:llm:local:detectBinary')
  ipcMain.removeHandler('bitsentry:llm:local:listModels')
  ipcMain.removeHandler('bitsentry:llm:local:doctor')
}

function resolvePreferredBinaryPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  return undefined
}
