import {
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
  type AgentRuntimeWindow,
  type AgentRuntimeEventPayload,
  createDesktopAgentRuntimeBindings,
} from '@bitsentry-ce/coding-agents'
import {
  isLocalCodingAgentDeltaStreamingEnabled,
  recordCodingAgentDebugAnomaly,
  recordCodingAgentDebugEvent,
} from './desktop-coding-agents.js'

export type {
  AgentRuntimeLlmAdapter,
  AgentRuntimeRunbookGateway,
  AgentRuntimeWindow,
}

const agentRuntimeBindings = createDesktopAgentRuntimeBindings({
  isLocalCodingAgentDeltaStreamingEnabled,
  recordCodingAgentDebugEvent,
  recordCodingAgentDebugAnomaly,
})

export type { AgentRuntimeEventPayload }
export const AgentRuntimeService = agentRuntimeBindings.AgentRuntimeService
