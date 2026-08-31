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
import type { DesktopPluginRuntimeService } from '@bitsentry-ce/core/features/plugins'
import type { RunbookContextV1 } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.types'
import type { RunbookAuthoringProposalPersistence } from '@bitsentry-ce/core/features/runbooks'
import type {
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookGateway,
  AgentRuntimeRunbookStore,
  AgentRuntimeWindow,
  RunbookAuthoringProposalDecisionResult,
  RunbookAuthoringProposalReview,
} from './agent-runtime.service.js'

export interface AgentRuntimeSessionController {
  start(input: AgentStartInput): Promise<string>
  send(input: AgentSendInput): Promise<string>
  cancel(sessionId: string): void
  destroy(): void
  getStatus(sessionId: string): AgentSessionStatus
  getSnapshot(sessionId: string): AgentThreadSnapshot
  listRunbookAuthoringProposals(input: { sessionId?: string; incidentThreadId?: string }): Promise<RunbookAuthoringProposalReview[]>
  approveRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; approvedOperationIds?: string[] }): Promise<RunbookAuthoringProposalDecisionResult>
  rejectRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; reason?: string }): Promise<RunbookAuthoringProposalDecisionResult>
  requestRunbookAuthoringRevision(input: { sessionId?: string; incidentThreadId?: string; proposalId: string; requestedEdit: string }): Promise<RunbookAuthoringProposalDecisionResult>
  restoreRunbookAuthoringProposal(input: { sessionId?: string; incidentThreadId?: string; proposalId: string }): Promise<RunbookAuthoringProposalDecisionResult>
}

export interface AgentHandlerDependencies {
  agentRuntime: AgentRuntimeSessionController
  runbookGateway?: AgentRuntimeRunbookGateway
}

export interface AgentServiceDependencies {
  llmAdapter: AgentRuntimeLlmAdapter
  runbookGateway?: AgentRuntimeRunbookGateway
  runbookStore?: AgentRuntimeRunbookStore
  onRunbooksChanged?: () => void
  pluginRuntime?: DesktopPluginRuntimeService
  authoringProposalStore?: RunbookAuthoringProposalPersistence
  windowGetter: () => AgentRuntimeWindow | null
}

export type AgentRuntimeServiceClass = new (
  windowGetter: () => AgentRuntimeWindow | null,
  llmAdapter: AgentRuntimeLlmAdapter,
  runbookGateway?: AgentRuntimeRunbookGateway,
  runbookStore?: AgentRuntimeRunbookStore,
  onRunbooksChanged?: () => void,
  pluginRuntime?: DesktopPluginRuntimeService,
  authoringProposalStore?: RunbookAuthoringProposalPersistence,
) => AgentRuntimeSessionController

export function createDesktopAgentService(
  dependencies: AgentServiceDependencies,
  services: { AgentRuntimeService: AgentRuntimeServiceClass },
): AgentRuntimeSessionController {
  const { llmAdapter, runbookGateway, runbookStore, onRunbooksChanged, pluginRuntime, authoringProposalStore, windowGetter } = dependencies
  return new services.AgentRuntimeService(
    windowGetter,
    llmAdapter,
    runbookGateway,
    runbookStore,
    onRunbooksChanged,
    pluginRuntime,
    authoringProposalStore,
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
    'agent:listRunbookAuthoringProposals': (payload: unknown): Promise<RunbookAuthoringProposalReview[]> => agentRuntime.listRunbookAuthoringProposals(payload as { sessionId?: string; incidentThreadId?: string }),
    'agent:approveRunbookAuthoringProposal': (payload: unknown): Promise<RunbookAuthoringProposalDecisionResult> => agentRuntime.approveRunbookAuthoringProposal(payload as { sessionId?: string; incidentThreadId?: string; proposalId: string; approvedOperationIds?: string[] }),
    'agent:rejectRunbookAuthoringProposal': (payload: unknown): Promise<RunbookAuthoringProposalDecisionResult> => agentRuntime.rejectRunbookAuthoringProposal(payload as { sessionId?: string; incidentThreadId?: string; proposalId: string; reason?: string }),
    'agent:requestRunbookAuthoringRevision': (payload: unknown): Promise<RunbookAuthoringProposalDecisionResult> => agentRuntime.requestRunbookAuthoringRevision(payload as { sessionId?: string; incidentThreadId?: string; proposalId: string; requestedEdit: string }),
    'agent:restoreRunbookAuthoringProposal': (payload: unknown): Promise<RunbookAuthoringProposalDecisionResult> => agentRuntime.restoreRunbookAuthoringProposal(payload as { sessionId?: string; incidentThreadId?: string; proposalId: string }),
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
