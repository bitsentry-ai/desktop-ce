import { getHostTools, type AgentSessionRef } from '@bitsentry-ce/core/features/agent-runtime'

/**
 * Incident-chat boundary for providers that expose BitSentry's runbook MCP.
 *
 * The user prompt is deliberately not trusted to carry this safety boundary:
 * it must be present whenever the provider receives the host tools.
 */
export interface RunbookOnlyScopeOptions {
  includeProposalInstructions?: boolean
  includeParameterInstructions?: boolean
  includeMultiRunbookInstructions?: boolean
}

export function scopeOptionsFor(session: AgentSessionRef | undefined): RunbookOnlyScopeOptions {
  return {
    includeProposalInstructions: (session?.runbookAuthoringProposals?.length ?? 0) > 0,
    includeParameterInstructions: session?.hasRunbookParameters === true,
    includeMultiRunbookInstructions: session?.hasMultipleRunbooksInPlay === true,
  }
}

export function buildRunbookOnlyScope(options: RunbookOnlyScopeOptions = {}): string {
  const hostToolNames = getHostTools().map((toolDefinition) => toolDefinition.name).join(', ')
  const instructions = [
    'This is a BitSentry incident-chat session.',
    `Your BitSentry incident-operation tools are: ${hostToolNames}. The provider may also expose built-in tools, but they are not permitted for incident work.`,
    'You must NEVER execute maintenance or remediation steps directly with built-in tools in an incident session. Anything that changes the operator\'s system goes through a runbook proposal, operator approval, and the runbook engine; there is no direct-execution fallback when a runbook is missing or unapproved.',
    'Runbooks are approved operator-executed action sequences; their shell, http, plugin, and other actions are content, not direct tool access.',
    'For runbook changes, use the matching proposal tool. Proposals are pending drafts, never executions, regardless of their actions.',
    'For a first proposal, omit parentProposalId. For a revision, pass only the exact proposalId returned by the previous proposal; never invent a parent id, use a title or slug, or use a zero UUID. An approved proposal is terminal. To change a saved runbook, omit parentProposalId on the first edit proposal.',
    'Every double-brace placeholder in a runbook action must have a matching action parameter with both id and key. Do not use undeclared placeholders.',
    'Do not refuse a proposal because of its actions; the operator corrects details during review.',
    'Never claim a runbook was created, edited, or saved unless the operator approved the proposal and persistence succeeded.',
    'To run an existing runbook, use execute_runbook, then call get_runbook_execution once with waitForCompletion: true. Do not poll it.',
    'If a runbook tool call fails or appears missing, call list_runbooks once to verify availability before concluding anything; if that also fails, report that runbook tools are unreachable in this session.',
  ]
  if (options.includeProposalInstructions === true) {
    instructions.splice(7, 0, 'When revising a pending create-kind proposal, use propose_runbook_create because the draft was never saved; when revising a pending edit-kind proposal, use propose_runbook_edit against the same target runbook. Pass the proposalId being revised as parentProposalId so the artifact version history remains connected.')
  }
  if (options.includeParameterInstructions === true) {
    instructions.push('If list_runbooks shows required parameters, supply them before starting that runbook; user-provided values override defaults.')
  }
  if (options.includeMultiRunbookInstructions === true) {
    instructions.push('For incident diagnosis requiring multiple data sources, execute each required runbook and inspect all completed results before finalizing.')
  }
  return instructions.join(' ')
}

export function prependRunbookOnlyScope(prompt: string, options: RunbookOnlyScopeOptions = {}): string {
  return [
    '## BitSentry incident-session scope',
    buildRunbookOnlyScope(options),
    '## Conversation',
    prompt,
  ].join('\n\n')
}
