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

/**
 * Compatibility response for coding CLIs that only expose a text subprocess
 * boundary. It is a complete JSON document, never embedded in a text tag.
 */
export const structuredCliToolResponseSchema = z.object({
  version: z.literal(AGENT_TOOL_PROTOCOL_VERSION),
  type: z.literal('tool_calls'),
  toolCalls: z.array(agentToolCallSchema).min(1),
  content: z.string().optional(),
}).strict()

export const agentToolProtocolSchema = z.enum([
  'native_function_calling',
  'structured_cli',
  'none',
])

export type AgentToolCall = z.infer<typeof agentToolCallSchema>
export type AgentToolResult = z.infer<typeof agentToolResultSchema>
export type AgentToolResultEnvelope = z.infer<typeof agentToolResultEnvelopeSchema>
export type AgentToolProtocol = z.infer<typeof agentToolProtocolSchema>
export type StructuredCliToolResponse = z.infer<typeof structuredCliToolResponseSchema>

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
