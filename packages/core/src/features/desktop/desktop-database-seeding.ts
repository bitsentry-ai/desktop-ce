type SettingRecord = {
  key?: unknown
  value?: unknown
}

export type DesktopDatabaseSeedClient = {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<SettingRecord | null>
    create(args: { data: { key: string; value: string; type: string } }): Promise<unknown>
  }
}

export type DesktopDatabaseSeedingOptions = {
  defaultLlmProvider: string
  logger?: {
    info(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
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
    } catch (error) {
      logger.error('[database] Failed to seed defaults:', error)
      throw error
    }
  }

  return {
    seedDefaults,
  }
}
