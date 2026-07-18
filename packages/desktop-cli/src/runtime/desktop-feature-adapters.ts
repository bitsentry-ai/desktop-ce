// Barrel export for feature adapters still used by desktop platform wiring.

// Error Sources feature
export { SqliteErrorSourcesRepositoryAdapter } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-sources.adapter'
export { SqliteErrorIssuesRepositoryAdapter } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-issues.adapter'
export { SqliteErrorEventsRepositoryAdapter } from '@bitsentry-ce/core/features/error-sources/desktop-sqlite-error-events.adapter'

// Settings feature
export {
  DesktopSqliteSettingsRepositoryAdapter as SqliteSettingsRepositoryAdapter,
} from '@bitsentry-ce/core/features/settings/desktop-sqlite-settings-repository.adapter'
export { DesktopSettingsAdapter } from '@bitsentry-ce/core/features/auth'

// Local AI providers (Claude Code / Codex CLI)
export { CodingAgentsProviderService } from './desktop-coding-agents.js'
