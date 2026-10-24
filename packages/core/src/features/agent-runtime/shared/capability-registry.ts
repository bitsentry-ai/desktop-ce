/**
 * Tool Registry
 *
 * Central registry of all available agentic tools.
 * All tools are allowlisted and schema-validated.
 *
 */

import type { ToolDefinition } from '../types'
import { sshJournalQueryTool } from '../capabilities/ssh-journal-query.capability'
import { listLogSourcesTool } from '../capabilities/list-log-sources.capability'
import { getCheckpointTool } from '../capabilities/get-checkpoint.capability'
import { executeShellCommandTool } from '../capabilities/execute-shell-command.capability'
import { executeHttpRequestTool } from '../capabilities/execute-http-request.capability'

export type { ToolDefinition } from '../types'

/**
 * Tool registry with all available tools.
 *
 * IMPORTANT:
 * - Only tools in this registry are executable by the agent
 * - All tool inputs are schema-validated before execution
 * - All tools execute in main process only
 */
const toolRegistry: Record<string, ToolDefinition> = {
  ssh_journal_query: sshJournalQueryTool as ToolDefinition,
  list_log_sources: listLogSourcesTool,
  get_checkpoint: getCheckpointTool,
  execute_shell_command: executeShellCommandTool as ToolDefinition,
  execute_http_request: executeHttpRequestTool as ToolDefinition,
}

/**
 * Get a tool by name.
 *
 * @param name - Tool name
 * @returns Tool definition or undefined if not found
 */
export function getTool(name: string): ToolDefinition | undefined {
  return toolRegistry[name]
}

/**
 * Get all available tool names.
 *
 * @returns Array of tool names
 */
export function getToolNames(): string[] {
  return Object.keys(toolRegistry)
}

/**
 * Get all tool definitions for LLM consumption.
 *
 * @returns Array of tool definitions (name, description, schema)
 */
export function getAllToolDefinitions(): Array<{
  name: string
  description: string
  inputSchema: ToolDefinition['inputSchema']
}> {
  return Object.values(toolRegistry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }))
}

/**
 * Validate tool input against its schema.
 *
 * @param toolName - Name of the tool
 * @param input - Raw input to validate
 * @returns Validated input or throws error
 */
export function validateToolInput(toolName: string, input: unknown): unknown {
  const tool = getTool(toolName)
  if (tool === undefined) {
    throw new Error(`Unknown tool: ${toolName}`)
  }
  return tool.inputSchema.parse(input)
}

/**
 * Check if a tool exists.
 *
 * @param name - Tool name
 * @returns True if tool exists
 */
export function hasTool(name: string): boolean {
  return name in toolRegistry
}
