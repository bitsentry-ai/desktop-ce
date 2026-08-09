import {
  executeHostTool,
  getHostTools,
  type HostToolContext,
  type HostToolEvent,
  type HostToolSpec,
} from '@bitsentry-ce/core/features/agent-runtime'

export interface HostToolCallResult extends Record<string, unknown> {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export type HostToolDefinition = HostToolSpec<unknown>

export interface HostToolCore {
  readonly tools: readonly HostToolDefinition[]
  call(name: string, args: unknown): Promise<HostToolCallResult>
}

export function createHostToolCore(
  context: HostToolContext,
  onToolEvent?: (event: HostToolEvent) => void,
): HostToolCore {
  return {
    tools: getHostTools(),
    async call(name: string, args: unknown): Promise<HostToolCallResult> {
      const result = await executeHostTool({
        ...context,
        onToolEvent: (event) => {
          onToolEvent?.(event)
          context.onToolEvent?.(event)
        },
      }, name, args)
      const text = result?.error ?? result?.output ?? 'Host tool completed without output.'
      return {
        content: [{ type: 'text', text }],
        ...(result?.error !== undefined ? { isError: true } : {}),
      }
    },
  }
}
