import log from 'electron-log'
import {
  type ClaudeCodeExecutionOptions,
  type CodingAgentsErrorContext,
  type CodingAgentsSettingsStore,
  codexStreamDeltasFromNotification,
  createDesktopCodingAgentBindings,
  normalizeCodexExecutionError,
  type CodexDebugRecorder,
  type CodexExecutionOptions,
  type OpenCodeDebugRecorder,
  type OpenCodeExecutionOptions,
} from '@bitsentry-ce/coding-agents'
import {
  addBreadcrumb,
  captureException as captureDesktopSentryException,
  captureMessage as captureDesktopSentryMessage,
} from './desktop-sentry.js'

export type {
  ClaudeCodeExecutionOptions,
  CodingAgentsSettingsStore,
  CodexDebugRecorder,
  CodexExecutionOptions,
  OpenCodeDebugRecorder,
  OpenCodeExecutionOptions,
} from '@bitsentry-ce/coding-agents'
export {
  codexStreamDeltasFromNotification,
  normalizeCodexExecutionError,
} from '@bitsentry-ce/coding-agents'

const desktopCodingAgentBindings = createDesktopCodingAgentBindings({
  log,
  addBreadcrumb,
  captureMessage(message: string, level: string) {
    let sentryLevel: 'info' | 'warning' | 'error' = 'info'
    if (level === 'warning' || level === 'error') {
      sentryLevel = level
    }
    captureDesktopSentryMessage(
      message,
      sentryLevel,
    )
  },
  captureException(error: unknown, context: CodingAgentsErrorContext) {
    const sentryContext: Record<string, unknown> = { ...context }
    captureDesktopSentryException(
      error,
      sentryContext,
    )
  },
})

export const isCodingAgentDebugEnabled =
  () => desktopCodingAgentBindings.isCodingAgentDebugEnabled()

export const isLocalCodingAgentDeltaStreamingEnabled =
  () => desktopCodingAgentBindings.isLocalCodingAgentDeltaStreamingEnabled()

export const recordCodingAgentDebugEvent =
  (...args: Parameters<typeof desktopCodingAgentBindings.recordCodingAgentDebugEvent>) => {
    desktopCodingAgentBindings.recordCodingAgentDebugEvent(...args)
  }

export const recordCodingAgentDebugAnomaly =
  (...args: Parameters<typeof desktopCodingAgentBindings.recordCodingAgentDebugAnomaly>) => {
    desktopCodingAgentBindings.recordCodingAgentDebugAnomaly(...args)
  }

export const executeClaudeCode = (
  ...args: Parameters<typeof desktopCodingAgentBindings.executeClaudeCode>
) => desktopCodingAgentBindings.executeClaudeCode(...args)
export const executeCodex = (
  ...args: Parameters<typeof desktopCodingAgentBindings.executeCodex>
) => desktopCodingAgentBindings.executeCodex(...args)
export const executeOpenCode = (
  ...args: Parameters<typeof desktopCodingAgentBindings.executeOpenCode>
) => desktopCodingAgentBindings.executeOpenCode(...args)
export const CodingAgentsProviderService =
  desktopCodingAgentBindings.CodingAgentsProviderService
