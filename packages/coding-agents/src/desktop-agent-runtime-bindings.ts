import {
  AgentRuntimeService as SharedAgentRuntimeService,
  type AgentRuntimeDebugHooks,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookExecutionService,
  type AgentRuntimeRunbookStore,
  type AgentRuntimeWindow,
} from './agent-runtime.service'

export function createDesktopAgentRuntimeBindings(
  debugHooks: AgentRuntimeDebugHooks,
): {
  AgentRuntimeService: new (
    windowGetter: () => AgentRuntimeWindow | null,
    llmAdapter: AgentRuntimeLlmAdapter,
    runbookStore?: AgentRuntimeRunbookStore,
    runbookExecutionService?: AgentRuntimeRunbookExecutionService,
  ) => SharedAgentRuntimeService
} {
  return {
    AgentRuntimeService: class AgentRuntimeService extends SharedAgentRuntimeService {
      constructor(
        windowGetter: () => AgentRuntimeWindow | null,
        llmAdapter: AgentRuntimeLlmAdapter,
        runbookStore?: AgentRuntimeRunbookStore,
        runbookExecutionService?: AgentRuntimeRunbookExecutionService,
      ) {
        super(
          windowGetter,
          llmAdapter,
          runbookStore,
          runbookExecutionService,
          debugHooks,
        )
      }
    },
  }
}
