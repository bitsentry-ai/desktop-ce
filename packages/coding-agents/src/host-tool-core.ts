import {
  executeHostTool,
  getHostTools,
  type HostToolContext,
  type HostToolEvent,
  type HostToolSpec,
} from '@bitsentry-ce/core/features/agent-runtime'
import { z } from 'zod'

export interface HostToolCallResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export type HostToolDefinition = HostToolSpec<unknown>

export interface HostToolCore {
  readonly tools: readonly HostToolDefinition[]
  inputSchemaFor(tool: HostToolDefinition): z.ZodType
  call(name: string, args: unknown): Promise<HostToolCallResult>
}

export function createHostToolCore(
  context: HostToolContext,
  onToolEvent?: (event: HostToolEvent) => void,
  contextId?: string,
): HostToolCore {
  const contextIdSchema = z.string().min(1).describe(
    'Omit contextId. The BitSentry MCP shim injects the scoped context handle automatically.',
  )
  const requiresContextId = (tool: HostToolDefinition): boolean =>
    contextId !== undefined && tool.name !== 'list_runbooks' && tool.name !== 'list_plugins'

  const inputSchemaFor = (tool: HostToolDefinition): z.ZodType => {
    if (contextId === undefined) return tool.argsSchema
    return tool.argsSchema.extend({
      contextId: requiresContextId(tool) ? contextIdSchema : contextIdSchema.optional(),
    })
  }

  return {
    tools: getHostTools(),
    inputSchemaFor,
    async call(name: string, args: unknown): Promise<HostToolCallResult> {
      const tool = getHostTools().find((candidate) => candidate.name === name)
      const suppliedContextId = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>).contextId
        : undefined
      if (contextId !== undefined && tool !== undefined && suppliedContextId !== undefined && suppliedContextId !== contextId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              code: 'INVALID_CONTEXT_HANDLE',
              message: 'The contextId is not authorised for this host-tool session. Omit contextId so the BitSentry MCP shim can inject the scoped handle.',
            }),
          }],
          isError: true,
        }
      }
      const toolArgs = args !== null && typeof args === 'object' && !Array.isArray(args)
        ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([key]) => key !== 'contextId'))
        : args
      const result = await executeHostTool({
        ...context,
        onToolEvent: (event) => {
          onToolEvent?.(event)
          context.onToolEvent?.(event)
        },
      }, name, toolArgs)
      const rawText = result?.error ?? result?.output ?? 'Host tool completed without output.'
      let text = rawText
      if (contextId !== undefined) {
        try {
          const payload = JSON.parse(rawText) as unknown
          if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
            text = JSON.stringify({ contextId, ...payload }, null, 2)
          }
        } catch {
          // Tool output that is not a JSON object cannot carry a structured handle.
        }
      }
      return {
        content: [{ type: 'text', text }],
        ...(result?.error !== undefined ? { isError: true } : {}),
      }
    },
  }
}
