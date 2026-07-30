import { z } from 'zod'

/**
 * Versioned envelope shared by every provider boundary before a host operation
 * is allowed to reach the agent runtime.
 */
export const AGENT_TOOL_PROTOCOL_VERSION = 1 as const

export const agentToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
}).strict()

export const agentToolResultSchema = z.object({
  output: z.string().optional(),
  artifactId: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
}).strict()

export const agentToolResultEnvelopeSchema = z.object({
  version: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  result: agentToolResultSchema,
}).strict()

export const agentToolProtocolSchema = z.enum([
  'native_function_calling',
  'structured_cli',
  'legacy_text',
  'none',
])

export type AgentToolCall = z.infer<typeof agentToolCallSchema>
export type AgentToolResult = z.infer<typeof agentToolResultSchema>
export type AgentToolResultEnvelope = z.infer<typeof agentToolResultEnvelopeSchema>
export type AgentToolProtocol = z.infer<typeof agentToolProtocolSchema>

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
