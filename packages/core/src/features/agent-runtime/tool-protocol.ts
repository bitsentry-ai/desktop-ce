import { z } from 'zod'

/**
 * Versioned envelope shared by every provider boundary before a host operation
 * is allowed to reach the agent runtime.
 */
const AGENT_TOOL_PROTOCOL_VERSION = 1 as const

export const agentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
}).strict()

const agentToolResultSchema = z.object({
  output: z.string().optional(),
  artifactId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict()

const agentToolResultEnvelopeSchema = z.object({
  version: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  result: agentToolResultSchema,
}).strict()

export type AgentToolCall = z.infer<typeof agentToolCallSchema>
export type AgentToolResult = z.infer<typeof agentToolResultSchema>
export type AgentToolResultEnvelope = z.infer<typeof agentToolResultEnvelopeSchema>
export type AgentToolProtocol = 'native_function_calling' | 'mcp' | 'none'

export function createAgentToolResultEnvelope(
  toolCall: AgentToolCall,
  result: AgentToolResult,
): AgentToolResultEnvelope {
  return agentToolResultEnvelopeSchema.parse({
    version: AGENT_TOOL_PROTOCOL_VERSION,
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
  })
}
