type SettingRecord = {
  key?: unknown
  value?: unknown
}

type RunbookActionRecord = {
  id?: unknown
  title?: unknown
  prompt?: unknown
  llmProviderKey?: unknown
  llmModel?: unknown
}

export type DesktopDatabaseSeedClient = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<SettingRecord | null>
    create(args: { data: { key: string; value: string; type: string } }): Promise<unknown>
    update(args: {
      where: { key: string }
      data: { value: string; updatedAt: string }
    }): Promise<unknown>
    findMany(args: {}): Promise<SettingRecord[]>
    delete(args: { where: { key: string } }): Promise<unknown>
  }
  runbookAction: {
    findMany(args: { where?: Record<string, unknown> }): Promise<RunbookActionRecord[]>
    update(args: {
      where: { id: string }
      data: { llmProviderKey: string; llmModel: string; updatedAt: string }
    }): Promise<unknown>
  }
}

export type DesktopDatabaseSeedingOptions = {
  defaultLlmProvider: string
  migrateRemovedCloudLlmSettings?: boolean
  migrateCeKanyeRestRunbook?: boolean
  logger?: {
    info(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  }
}

const CLI_PROVIDER_KEYS = new Set(['claude_code', 'codex', 'opencode', 'cursor'])
const REMOVED_CLOUD_PROVIDER_KEYS = [
  'groq',
  'kilocode',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'flowise',
]
const KANYE_REST_ACTION_TITLE = 'What did kanye say?'
const KANYE_REST_ACTION_PROMPT = 'Make a philosophical break down of what Kanye said.'
const KANYE_REST_CE_PROVIDER = 'codex'
const KANYE_REST_CE_MODEL = 'gpt-5.4-mini'

function readSettingString(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim()
}

async function migrateCeKanyeRestRunbook(
  client: DesktopDatabaseSeedClient,
  logger: NonNullable<DesktopDatabaseSeedingOptions['logger']>,
): Promise<void> {
  const actions = await client.runbookAction.findMany({
    where: {
      title: KANYE_REST_ACTION_TITLE,
    },
  })

  let migratedCount = 0

  for (const action of actions) {
    const id = readSettingString(action.id)
    if (id.length === 0) {
      continue
    }

    if (readSettingString(action.prompt) !== KANYE_REST_ACTION_PROMPT) {
      continue
    }

    if (
      readSettingString(action.llmProviderKey) === KANYE_REST_CE_PROVIDER &&
      readSettingString(action.llmModel) === KANYE_REST_CE_MODEL
    ) {
      continue
    }

    await client.runbookAction.update({
      where: { id },
      data: {
        llmProviderKey: KANYE_REST_CE_PROVIDER,
        llmModel: KANYE_REST_CE_MODEL,
        updatedAt: new Date().toISOString(),
      },
    })
    migratedCount += 1
  }

  if (migratedCount > 0) {
    logger.info(
      `[database] Migrated ${String(migratedCount)} Kanye Rest action(s) to ${KANYE_REST_CE_PROVIDER}/${KANYE_REST_CE_MODEL}`,
    )
  }
}

async function migrateRemovedCloudLlmSettings(
  client: DesktopDatabaseSeedClient,
  fallbackProvider: string,
  logger: NonNullable<DesktopDatabaseSeedingOptions['logger']>,
): Promise<void> {
  const primary = await client.setting.findUnique({ where: { key: 'llm.provider' } })
  const previousProvider = readSettingString(primary?.value)

  if (primary !== null && !CLI_PROVIDER_KEYS.has(previousProvider)) {
    await client.setting.update({
      where: { key: 'llm.provider' },
      data: { value: fallbackProvider, updatedAt: new Date().toISOString() },
    })
    logger.info(
      `[database] Migrated llm.provider from removed provider '${previousProvider}' to '${fallbackProvider}'`,
    )
  }

  const removedPrefixes = REMOVED_CLOUD_PROVIDER_KEYS.map((key) => `llm.${key}.`)
  const removedExactKeys = new Set([
    'llm.mcp.baseUrl',
    'llm.mcp.apiKey',
    'mcp.baseUrl',
    'mcp.apiKey',
  ])
  const settings = await client.setting.findMany({})

  for (const setting of settings) {
    const key = readSettingString(setting.key)
    const isRemoved =
      removedExactKeys.has(key) || removedPrefixes.some((prefix) => key.startsWith(prefix))

    if (isRemoved) {
      await client.setting.delete({ where: { key } })
      logger.info(`[database] Removed orphaned cloud LLM setting: ${key}`)
    }
  }
}

export function createDesktopDatabaseSeeders(options: DesktopDatabaseSeedingOptions): {
  seedDefaults(client: DesktopDatabaseSeedClient): Promise<void>
} {
  const logger = options.logger ?? console

  async function seedDefaults(client: DesktopDatabaseSeedClient): Promise<void> {
    try {
      const defaultSettings: Array<{ key: string; value: string; type: string }> = [
        { key: 'llm.provider', value: options.defaultLlmProvider, type: 'string' },
        { key: 'security.passwordMinLength', value: '8', type: 'number' },
        { key: 'security.require2FA', value: 'false', type: 'boolean' },
        { key: 'security.idleAutoLockEnabled', value: 'false', type: 'boolean' },
        { key: 'security.autoLockMinutes', value: '15', type: 'number' },
        { key: 'security.lockOnSleep', value: 'false', type: 'boolean' },
        { key: 'security.rememberMeExpiryHours', value: '720', type: 'number' },
        { key: 'app.setupCompleted', value: 'false', type: 'boolean' },
        { key: 'session.lockState', value: 'unlocked', type: 'string' },
      ]

      for (const setting of defaultSettings) {
        const existing = await client.setting.findUnique({ where: { key: setting.key } })
        if (existing === null) {
          await client.setting.create({ data: setting })
        }
      }

      logger.info('[database] Default seed data ensured')

      if (options.migrateRemovedCloudLlmSettings === true) {
        await migrateRemovedCloudLlmSettings(client, options.defaultLlmProvider, logger)
      }

      if (options.migrateCeKanyeRestRunbook === true) {
        await migrateCeKanyeRestRunbook(client, logger)
      }
    } catch (error) {
      logger.error('[database] Failed to seed defaults:', error)
      throw error
    }
  }

  return {
    seedDefaults,
  }
}
