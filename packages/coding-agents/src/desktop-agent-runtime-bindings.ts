import {
  AgentRuntimeService as SharedAgentRuntimeService,
  type AgentRuntimeDebugHooks,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
  type AgentRuntimeRunbookStore,
  type AgentRuntimeWindow,
} from './agent-runtime.service.js'

export function createDesktopAgentRuntimeBindings(
  debugHooks: AgentRuntimeDebugHooks,
): {
  AgentRuntimeService: new (
    windowGetter: () => AgentRuntimeWindow | null,
    llmAdapter: AgentRuntimeLlmAdapter,
    runbookGateway?: AgentRuntimeRunbookGateway,
    runbookStore?: AgentRuntimeRunbookStore,
    onRunbooksChanged?: () => void,
  ) => SharedAgentRuntimeService
} {
  return {
    AgentRuntimeService: class AgentRuntimeService extends SharedAgentRuntimeService {
      constructor(
        windowGetter: () => AgentRuntimeWindow | null,
        llmAdapter: AgentRuntimeLlmAdapter,
        runbookGateway?: AgentRuntimeRunbookGateway,
        runbookStore?: AgentRuntimeRunbookStore,
        onRunbooksChanged?: () => void,
      ) {
        super(
          windowGetter,
          llmAdapter,
          runbookGateway,
          debugHooks,
          runbookStore,
          onRunbooksChanged,
        )
      }
    },
  }
}
