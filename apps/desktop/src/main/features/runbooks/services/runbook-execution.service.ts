import { DesktopGlobalVariablesService } from '@bitsentry-ce/core/features/runbooks'
import { RunbookExecutionService as SharedRunbookExecutionService } from '@bitsentry-ce/core/features/runbooks/desktop-runbook-execution.service'
import type { AgentLlmAdapterService } from '@bitsentry-ce/coding-agents/agent-llm-adapter.service'
import { CodingAgentsProviderService } from '@bitsentry-ce/desktop-cli/runtime/desktop-coding-agents'
import { DesktopRunbookStore as RunbookStore } from '@bitsentry-ce/core/features/runbooks/desktop-runbook.store'
import type { ExternalSourceRunbookQueryExecutor } from './external-source-query.service'
import type { RunbookResultPersistence } from '../stores/runbook-result.store'
import type { RunbookExecutionWindowPort } from '@bitsentry-ce/core/features/runbooks/desktop-runbook-execution.service'
import type { DesktopPluginRuntimeService } from '@bitsentry-ce/core/features/plugins'

export class RunbookExecutionService extends SharedRunbookExecutionService {
  constructor(
    store: RunbookStore,
    globalVariablesService: DesktopGlobalVariablesService,
    llmAdapter: AgentLlmAdapterService,
    externalSourceQueryExecutor: ExternalSourceRunbookQueryExecutor,
    resultStore: RunbookResultPersistence,
    windowGetter: () => RunbookExecutionWindowPort | null,
    options?: { httpTimeoutMs?: number },
    localAiProvider?: InstanceType<typeof CodingAgentsProviderService>,
    pluginRuntime?: DesktopPluginRuntimeService,
  ) {
    super(
      store,
      globalVariablesService,
      llmAdapter,
      externalSourceQueryExecutor,
      resultStore,
      windowGetter,
      { ...options, edition: 'ce' },
      localAiProvider,
      pluginRuntime,
    )
  }
}
