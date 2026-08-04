import { getHostTools } from '@bitsentry-ce/core/features/agent-runtime'

/**
 * Incident-chat boundary for providers that expose BitSentry's runbook MCP.
 *
 * The user prompt is deliberately not trusted to carry this safety boundary:
 * it must be present whenever the provider receives the host tools.
 */
export function buildRunbookOnlyScope(includeProposalInstructions = false): string {
  const hostToolNames = getHostTools().map((toolDefinition) => toolDefinition.name).join(', ')
  const instructions = [
    'This is a BitSentry incident-chat session.',
    `Your BitSentry incident-operation tools are: ${hostToolNames}. The provider may also expose built-in tools, but they are not permitted for incident work.`,
    'You must NEVER execute maintenance or remediation steps directly with built-in tools in an incident session. Anything that changes the operator\'s system goes through a runbook proposal, operator approval, and the runbook engine; there is no direct-execution fallback when a runbook is missing or unapproved.',
    'Runbooks are separate from your own tool access. A runbook is a saved sequence of actions (shell, http, plugin, and others) that the operator executes on their own machines. Runbook content may legitimately include shell commands, including commands that install or update software on the operator\'s machine.',
    'For runbook changes, use the matching proposal tool. Proposals are pending drafts, never executions, regardless of their actions.',
    'Do not refuse a proposal because of its actions; the operator corrects details during review.',
    'If a runbook tool call fails or a runbook tool appears missing, call list_runbooks once to verify availability before concluding anything. If it succeeds, proceed; if it also fails, report that runbook tools are unreachable in this session.',
    'To run an existing runbook, use execute_runbook, then call get_runbook_execution once with waitForCompletion: true. Do not poll it.',
  ]
  if (includeProposalInstructions) {
    instructions.splice(7, 0, 'When revising a create-kind proposal, use propose_runbook_create because the draft was never saved; when revising an edit-kind proposal, use propose_runbook_edit against the same target runbook.')
  }
  return instructions.join(' ')
}

export function prependRunbookOnlyScope(prompt: string, includeProposalInstructions = false): string {
  return [
    '## BitSentry incident-session scope',
    buildRunbookOnlyScope(includeProposalInstructions),
    '## Conversation',
    prompt,
  ].join('\n\n')
}
