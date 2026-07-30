import {
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookExecutionService,
  type AgentRuntimeRunbookStore,
  type AgentRuntimeWindow,
  LOCAL_PROVIDER_POST_TOOL_RESPONSE_TIMEOUT_MS,
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
  AgentRuntimeRunbookExecutionService,
  AgentRuntimeRunbookStore,
  AgentRuntimeWindow,
}

const agentRuntimeBindings = createDesktopAgentRuntimeBindings({
  isLocalCodingAgentDeltaStreamingEnabled,
  recordCodingAgentDebugEvent,
  recordCodingAgentDebugAnomaly,
})

export { LOCAL_PROVIDER_POST_TOOL_RESPONSE_TIMEOUT_MS }
export type { AgentRuntimeEventPayload }
export const AgentRuntimeService = agentRuntimeBindings.AgentRuntimeService
