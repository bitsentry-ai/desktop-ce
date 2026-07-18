/**
 * Execute HTTP Request Tool
 *
 * Allows the agent to execute HTTP actions from runbooks.
 * This enables the agent to actually run HTTP requests when a runbook has http actions.
 */

import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolResult } from '../types'
import {
  OrchestrationError,
  runOrchestratedOperation,
} from '../shared/effect-orchestration'

const HTTP_TIMEOUT_MS = 30_000
const MAX_RESPONSE_LENGTH = 50_000

export const executeHttpRequestSchema = z.object({
  url: z.url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
})

type ExecuteHttpRequestInput = z.infer<typeof executeHttpRequestSchema>

function getRequestBody(input: ExecuteHttpRequestInput): string | undefined {
  if (input.method === 'GET') {
    return undefined
  }

  return input.body
}

function formatJsonBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return body
  }
}

function formatResponseBody(body: string, contentType: string): string {
  if (!contentType.toLowerCase().includes('json')) {
    return body
  }

  return formatJsonBody(body)
}

function getContentType(response: Response): string {
  return response.headers.get('content-type') ?? ''
}

function formatContentTypeLine(contentType: string): string {
  if (contentType === '') {
    return 'Content-Type: (unknown)'
  }

  return `Content-Type: ${contentType}`
}

function formatTruncationNotice(responseBody: string, truncatedBody: string): string | null {
  if (truncatedBody.length >= responseBody.length) {
    return null
  }

  return `\n[Response truncated to ${String(MAX_RESPONSE_LENGTH)} characters]`
}

function buildOutput(response: Response, responseBody: string): string {
  const truncatedBody = responseBody.slice(0, MAX_RESPONSE_LENGTH)
  const contentType = getContentType(response)
  const lines = [
    `HTTP ${String(response.status)} ${response.statusText}`,
    formatContentTypeLine(contentType),
    '',
    formatResponseBody(truncatedBody, contentType),
  ]
  const truncationNotice = formatTruncationNotice(responseBody, truncatedBody)
  if (truncationNotice !== null) {
    lines.push(truncationNotice)
  }

  return lines.join('\n')
}

function getHttpRequestError(error: unknown): string {
  if (error instanceof OrchestrationError && error.kind === 'cancelled') {
    return 'HTTP request cancelled'
  }

  if (error instanceof OrchestrationError && error.kind === 'timeout') {
    return `HTTP request timed out after ${String(HTTP_TIMEOUT_MS)}ms`
  }

  if (error instanceof Error) {
    return error.message
  }

  return 'Unknown HTTP request error'
}

async function executeHttpRequest(
  input: ExecuteHttpRequestInput,
  context: ToolContext,
): Promise<ToolResult> {
  context.onChunk(`Sending ${input.method} request to ${input.url}...`)

  try {
    return await runOrchestratedOperation({
      operation: 'HTTP request',
      signal: context.signal,
      timeoutMs: HTTP_TIMEOUT_MS,
      execute: async (signal) => {
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: getRequestBody(input),
          signal,
        })

        const responseBody = await response.text()
        return { output: buildOutput(response, responseBody) }
      },
    })
  } catch (error) {
    return { error: getHttpRequestError(error) }
  }
}

export const executeHttpRequestTool: ToolDefinition<ExecuteHttpRequestInput> = {
  name: 'execute_http_request',
  description: 'Execute an HTTP request. Use this when a runbook has http actions.',
  inputSchema: executeHttpRequestSchema,
  execute: executeHttpRequest,
}
