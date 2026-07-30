/**
 * Agent Runtime IPC Handlers
 *
 * IPC bridge and service composition helpers for the desktop agent runtime.
 */

import type { AgentThreadSnapshot } from '@bitsentry-ce/components/chat/types'
import type {
  AgentStartInput,
  AgentSendInput,
  AgentSessionStatus,
} from '@bitsentry-ce/core/features/agent-runtime/types'
import type {
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookExecutionService,
  AgentRuntimeRunbookStore,
  AgentRuntimeWindow,
} from './agent-runtime.service'

export interface AgentRuntimeSessionController {
  start(input: AgentStartInput): Promise<string>
  send(input: AgentSendInput): Promise<string>
  cancel(sessionId: string): void
  destroy(): void
  getStatus(sessionId: string): AgentSessionStatus
  getSnapshot(sessionId: string): AgentThreadSnapshot
}

export interface AgentHandlerDependencies {
  agentRuntime: AgentRuntimeSessionController
}

export interface AgentServiceDependencies {
  llmAdapter: AgentRuntimeLlmAdapter
  runbookStore?: AgentRuntimeRunbookStore
  runbookExecutionService?: AgentRuntimeRunbookExecutionService
  windowGetter: () => AgentRuntimeWindow | null
}

export type AgentRuntimeServiceClass = new (
  windowGetter: () => AgentRuntimeWindow | null,
  llmAdapter: AgentRuntimeLlmAdapter,
  runbookStore?: AgentRuntimeRunbookStore,
  runbookExecutionService?: AgentRuntimeRunbookExecutionService,
) => AgentRuntimeSessionController

export function createDesktopAgentService(
  dependencies: AgentServiceDependencies,
  services: { AgentRuntimeService: AgentRuntimeServiceClass },
): AgentRuntimeSessionController {
  const { llmAdapter, runbookStore, runbookExecutionService, windowGetter } = dependencies
  return new services.AgentRuntimeService(
    windowGetter,
    llmAdapter,
    runbookStore,
    runbookExecutionService,
  )
}

export function createDesktopAgentHandlers(
  dependencies: AgentHandlerDependencies,
): Record<string, (payload: unknown) => Promise<unknown>> {
  const { agentRuntime } = dependencies

  return {
    'agent:start': async (payload: unknown): Promise<{ sessionId: string }> => {
      const input = payload as AgentStartInput
      const sessionId = await agentRuntime.start(input)
      return { sessionId }
    },

    'agent:send': async (payload: unknown): Promise<{ sessionId: string }> => {
      const input = payload as AgentSendInput
      const sessionId = await agentRuntime.send(input)
      return { sessionId }
    },

    'agent:cancel': (payload: unknown): Promise<void> => {
      const input = payload as { sessionId: string }
      agentRuntime.cancel(input.sessionId)
      return Promise.resolve()
    },

    'agent:getStatus': (
      payload: unknown,
    ): Promise<AgentSessionStatus | null> => {
      const input = payload as { sessionId: string }
      try {
        return Promise.resolve(agentRuntime.getStatus(input.sessionId))
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('Session not found:')
        ) {
          return Promise.resolve(null)
        }
        throw error
      }
    },

    'agent:getSnapshot': (
      payload: unknown,
    ): Promise<AgentThreadSnapshot | null> => {
      const input = payload as { sessionId: string }
      try {
        return Promise.resolve(agentRuntime.getSnapshot(input.sessionId))
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('Session not found:')
        ) {
          return Promise.resolve(null)
        }
        throw error
      }
    },
  }
}
