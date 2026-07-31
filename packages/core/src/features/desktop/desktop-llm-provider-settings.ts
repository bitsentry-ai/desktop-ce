export const DESKTOP_LOCAL_AI_PROVIDER_KEYS = [
  'claude_code',
  'codex',
  'opencode',
  'cursor',
] as const

export type DesktopLocalAiProviderKey =
  (typeof DESKTOP_LOCAL_AI_PROVIDER_KEYS)[number]

export interface DesktopProviderRecord {
  hasApiKey: boolean
  baseUrl: string
  model: string
  availableModels: string[]
  isSelectable: boolean
  isPrimary: boolean
}

interface DesktopLocalProviderSettings {
  enabled: boolean
}

export interface DesktopLocalAiProviderPort {
  getSettings(): {
    claudeCode: DesktopLocalProviderSettings
    codex: DesktopLocalProviderSettings
    opencode: DesktopLocalProviderSettings
    cursor: DesktopLocalProviderSettings
  }
  isReady(providerKey: DesktopLocalAiProviderKey): boolean
  listModels(providerKey: DesktopLocalAiProviderKey): Promise<string[]>
}

export interface BuildDesktopLocalProviderRecordsOptions {
  localAiProvider: DesktopLocalAiProviderPort | null
  primaryProviderKey: string
  readModelSetting: (providerKey: DesktopLocalAiProviderKey) => Promise<string>
  /** Last successful discovery snapshot, used only when live discovery is empty. */
  readAvailableModels: (
    providerKey: DesktopLocalAiProviderKey,
  ) => Promise<string[]>
  resolveAvailableModels: (
    providerKey: DesktopLocalAiProviderKey,
    isReady: boolean,
    provider: DesktopLocalAiProviderPort,
  ) => Promise<string[]>
}

export interface SaveDesktopProviderSettingsConfig {
  baseUrl?: string
  model?: string
  availableModels?: string[]
  isSelectable?: boolean
  isPrimary?: boolean
}

export interface SaveDesktopProviderSettingsOptions {
  providerKey: string
  config: SaveDesktopProviderSettingsConfig
  upsertSetting: (
    key: string,
    value: string,
    type?: string,
    description?: string,
  ) => Promise<void>
  includeBaseUrl?: boolean
}

const LOCAL_PROVIDER_SETTINGS = [
  {
    key: 'claude_code',
    isEnabled: (
      settings: ReturnType<DesktopLocalAiProviderPort['getSettings']>,
    ): boolean => settings.claudeCode.enabled,
  },
  {
    key: 'codex',
    isEnabled: (
      settings: ReturnType<DesktopLocalAiProviderPort['getSettings']>,
    ): boolean => settings.codex.enabled,
  },
  {
    key: 'opencode',
    isEnabled: (
      settings: ReturnType<DesktopLocalAiProviderPort['getSettings']>,
    ): boolean => settings.opencode.enabled,
  },
  {
    key: 'cursor',
    isEnabled: (
      settings: ReturnType<DesktopLocalAiProviderPort['getSettings']>,
    ): boolean => settings.cursor.enabled,
  },
] as const satisfies ReadonlyArray<{
  key: DesktopLocalAiProviderKey
  isEnabled: (
    settings: ReturnType<DesktopLocalAiProviderPort['getSettings']>,
  ) => boolean
}>

export function isDesktopLocalAiProviderKey(
  providerKey: string,
): providerKey is DesktopLocalAiProviderKey {
  return DESKTOP_LOCAL_AI_PROVIDER_KEYS.includes(
    providerKey as DesktopLocalAiProviderKey,
  )
}

export function getDesktopLocalPrimaryProviderKey(
  rawPrimary: string,
): DesktopLocalAiProviderKey {
  if (isDesktopLocalAiProviderKey(rawPrimary)) {
    return rawPrimary
  }

  return 'codex'
}

export async function buildDesktopLocalProviderRecords(
  options: BuildDesktopLocalProviderRecordsOptions,
): Promise<Record<string, DesktopProviderRecord>> {
  const { localAiProvider } = options
  if (localAiProvider === null) {
    return {}
  }

  const result: Record<string, DesktopProviderRecord> = {}
  const settings = localAiProvider.getSettings()

  for (const providerMeta of LOCAL_PROVIDER_SETTINGS) {
    if (!providerMeta.isEnabled(settings)) continue

    const isReady = localAiProvider.isReady(providerMeta.key)
    let models = await options.resolveAvailableModels(
      providerMeta.key,
      isReady,
      localAiProvider,
    )
    if (isReady && models.length === 0) {
      models = await options.readAvailableModels(providerMeta.key)
    }

    result[providerMeta.key] = {
      hasApiKey: isReady,
      baseUrl: '',
      model: await options.readModelSetting(providerMeta.key),
      availableModels: models,
      isSelectable: isReady,
      isPrimary: options.primaryProviderKey === providerMeta.key,
    }
  }

  return result
}

export async function saveDesktopProviderSettings(
  options: SaveDesktopProviderSettingsOptions,
): Promise<void> {
  const { providerKey, config, upsertSetting, includeBaseUrl = false } = options

  if (includeBaseUrl && config.baseUrl !== undefined) {
    await upsertSetting(`llm.${providerKey}.baseUrl`, config.baseUrl)
  }
  if (config.model !== undefined) {
    await upsertSetting(`llm.${providerKey}.model`, config.model)
  }
  if (config.availableModels !== undefined) {
    await upsertSetting(
      `llm.${providerKey}.availableModels`,
      JSON.stringify(config.availableModels),
    )
  }
  if (config.isSelectable !== undefined) {
    await upsertSetting(
      `llm.${providerKey}.isSelectable`,
      String(config.isSelectable),
      'boolean',
    )
  }
  if (config.isPrimary === true) {
    await upsertSetting('llm.provider', providerKey)
  }
}
