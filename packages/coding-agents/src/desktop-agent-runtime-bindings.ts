import {
  AgentRuntimeService as SharedAgentRuntimeService,
  type AgentRuntimeDebugHooks,
  type AgentRuntimeLlmAdapter,
  type AgentRuntimeRunbookGateway,
  type AgentRuntimeRunbookStore,
  type AgentRuntimeWindow,
} from './agent-runtime.service.js'
import type { DesktopPluginRuntimeService } from '@bitsentry-ce/core/features/plugins'
import type { RunbookAuthoringProposalPersistence } from '@bitsentry-ce/core/features/runbooks'

export function createDesktopAgentRuntimeBindings(
  debugHooks: AgentRuntimeDebugHooks,
): {
  AgentRuntimeService: new (
    windowGetter: () => AgentRuntimeWindow | null,
    llmAdapter: AgentRuntimeLlmAdapter,
    runbookGateway?: AgentRuntimeRunbookGateway,
    runbookStore?: AgentRuntimeRunbookStore,
    onRunbooksChanged?: () => void,
    pluginRuntime?: DesktopPluginRuntimeService,
    authoringProposalStore?: RunbookAuthoringProposalPersistence,
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
        pluginRuntime?: DesktopPluginRuntimeService,
        authoringProposalStore?: RunbookAuthoringProposalPersistence,
      ) {
        super(
          windowGetter,
          llmAdapter,
          runbookGateway,
          debugHooks,
          runbookStore,
          onRunbooksChanged,
          pluginRuntime,
          authoringProposalStore,
        )
      }
    },
  }
}
