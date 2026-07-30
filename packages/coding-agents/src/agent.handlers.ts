/**
 * Agent Runtime IPC Handlers
 *
 * IPC bridge and service composition helpers for the desktop agent runtime.
 */

import type { AgentThreadSnapshot } from '@bitsentry-ce/components/chat/types'
import { z } from 'zod'
import type {
  AgentStartInput,
  AgentSendInput,
  AgentSessionStatus,
  RunbookContext,
} from '@bitsentry-ce/core/features/agent-runtime/types'
import type { RunbookContextV1 } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.types'
import type {
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookGateway,
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
  runbookGateway?: AgentRuntimeRunbookGateway
}

export interface AgentServiceDependencies {
  llmAdapter: AgentRuntimeLlmAdapter
  runbookGateway?: AgentRuntimeRunbookGateway
  windowGetter: () => AgentRuntimeWindow | null
}

export type AgentRuntimeServiceClass = new (
  windowGetter: () => AgentRuntimeWindow | null,
  llmAdapter: AgentRuntimeLlmAdapter,
  runbookGateway?: AgentRuntimeRunbookGateway,
) => AgentRuntimeSessionController

export function createDesktopAgentService(
  dependencies: AgentServiceDependencies,
  services: { AgentRuntimeService: AgentRuntimeServiceClass },
): AgentRuntimeSessionController {
  const { llmAdapter, runbookGateway, windowGetter } = dependencies
  return new services.AgentRuntimeService(
    windowGetter,
    llmAdapter,
    runbookGateway,
  )
}

export function createDesktopAgentHandlers(
  dependencies: AgentHandlerDependencies,
): Record<string, (payload: unknown) => Promise<unknown>> {
  const { agentRuntime, runbookGateway } = dependencies

  const resolveRunbookContext = async <T extends AgentStartInput | AgentSendInput>(
    input: T,
  ): Promise<T> => {
    if (input.runbookId === undefined) {
      return input
    }
    if (runbookGateway === undefined) {
      throw new Error('Runbook gateway is not configured')
    }

    const context = await runbookGateway.getRunbookContext(input.runbookId)
    if (
      input.runbookRevisionNumber !== undefined &&
      input.runbookRevisionNumber !== context.runbook.revisionNumber
    ) {
      throw new Error(
        `Runbook '${input.runbookId}' changed before this message could be sent`,
      )
    }

    return {
      ...input,
      runbookRevisionNumber: context.runbook.revisionNumber,
      runbookContext: toAgentRunbookContext(context),
    }
  }

  return {
    'agent:start': async (payload: unknown): Promise<{ sessionId: string }> => {
      const input = await resolveRunbookContext(agentStartInputSchema.parse(payload))
      const sessionId = await agentRuntime.start(input)
      return { sessionId }
    },

    'agent:send': async (payload: unknown): Promise<{ sessionId: string }> => {
      const input = await resolveRunbookContext(agentSendInputSchema.parse(payload))
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

const agentStartInputSchema = z.custom<AgentStartInput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { prompt?: unknown }).prompt === 'string' &&
    (value as { prompt: string }).prompt.trim().length > 0,
  { message: 'Invalid agent:start input' },
)

const agentSendInputSchema = z.custom<AgentSendInput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    (value as { message: string }).message.trim().length > 0,
  { message: 'Invalid agent:send input' },
)

function toAgentRunbookContext(context: RunbookContextV1): RunbookContext {
  return {
    id: context.runbook.id,
    title: context.runbook.title,
    description: context.runbook.description,
    actions: context.actions.map((action) => ({
      id: action.id,
      type: action.type,
      title: action.title,
      ...action.payload,
    })),
  }
}
