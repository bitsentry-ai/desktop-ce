/**
 * Get Checkpoint Tool
 *
 * Agentic tool for retrieving incremental log collection checkpoint.
 * Returns the last cursor for a log source to enable incremental collection.
 *
 * Note: This is a Phase 2A stub. Returns error until
 * backend checkpoint persistence is implemented.
 */

import { z } from 'zod'
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types'

/**
 * Zod schema for get_checkpoint tool input.
 */
export const getCheckpointSchema = z.object({
  sourceId: z.string().optional().describe('Log source ID to get checkpoint for'),
  host: z.string().optional().describe('Host to get checkpoint for (if no sourceId)'),
})

/**
 * Get checkpoint tool executor.
 *
 * Returns the last journal cursor for incremental log collection.
 * Currently returns "not configured" message - backend persistence not yet implemented.
 *
 * @param _input - Tool input with optional sourceId or host
 * @param _context - Tool execution context
 * @returns Tool result with checkpoint or error message
 */
function executeGetCheckpoint(
  _input: unknown,
  _context: ToolContext,
): Promise<ToolResult> {
  // Checkpoint persistence is not implemented yet.
  // In full implementation, this would:
  // - Query SQLite for last cursor per source/host
  // - Return cursor to use with --after-cursor in journalctl
  // - Track collection position for incremental updates

  return Promise.resolve({
    output: JSON.stringify({
      checkpoint: null,
      note: 'Checkpoint persistence not configured yet. Use ssh_journal_query with "since" parameter for time-based collection.',
    }, null, 2),
  })
}

/**
 * Tool definition for get_checkpoint.
 *
 * Registers the tool with the agent runtime, providing:
 * - Name and description for LLM consumption
 * - Zod schema for input validation
 * - Executor function for tool logic
 */
export const getCheckpointTool: ToolDefinition = {
  name: 'get_checkpoint',

  description: `Get the last checkpoint (journal cursor) for a log source.
Enables incremental log collection by returning the cursor to use with --after-cursor.
Note: Currently returns null - checkpoint persistence not yet configured.`,

  inputSchema: getCheckpointSchema,

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    return executeGetCheckpoint(input, context)
  },
}
