/**
 * List Log Sources Tool
 *
 * Agentic tool for listing saved SSH log sources.
 * Returns configured servers for log collection.
 *
 * Note: This is a Phase 2A stub. Returns empty list until
 * backend persistence is implemented.
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types'

/**
 * Zod schema for list_log_sources tool input.
 * No parameters required.
 */
export const listLogSourcesSchema = z.object({})

/**
 * List log sources tool executor.
 *
 * Returns saved SSH log sources (servers).
 * Currently returns empty list - backend persistence not yet implemented.
 *
 * @param _input - Empty input (no params)
 * @param _context - Tool execution context
 * @returns Tool result with sources list
 */
function executeListLogSources(
  _input: unknown,
  _context: ToolContext,
): Promise<ToolResult> {
  // Saved log-source persistence is not implemented yet.
  // In full implementation, this would query:
  // - SQLite table of saved log sources
  // - Each source: host, username, default since, units, etc.

  return Promise.resolve({
    output: JSON.stringify({
      sources: [],
      note: 'Log source persistence not configured yet. Use ssh_journal_query with explicit parameters.',
    }, null, 2),
  })
}

/**
 * Tool definition for list_log_sources.
 *
 * Registers the tool with the agent runtime, providing:
 * - Name and description for LLM consumption
 * - Zod schema for input validation (empty for this tool)
 * - Executor function for tool logic
 */
export const listLogSourcesTool: ToolDefinition = {
  name: 'list_log_sources',

  description: `List saved SSH log sources (configured servers for log collection).
Returns a list of previously configured log sources with connection details.
Note: Currently returns empty list - persistence not yet configured.`,

  inputSchema: listLogSourcesSchema,

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    return executeListLogSources(input, context)
  },
}
