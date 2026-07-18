/**
 * SSH journalctl Query Tool
 *
 * Agentic tool for querying remote systemd journals via SSH.
 * Uses allowlisted command builder with no raw shell execution.
 *
 * Guardrails:
 * - Main-process execution only
 * - System SSH identity (no key storage)
 * - Allowlisted journalctl flags only
 */

import { spawn } from 'child_process'
import { z } from 'zod'
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  SshJournalQueryInput,
} from '../types'
import {
  buildSshJournalctlCommand,
  classifySshError,
} from '../shared/ssh-journal-query-builder'
import { runOrchestratedOperation } from '../shared/effect-orchestration'

const log = console
const SSH_JOURNAL_QUERY_TIMEOUT_MS = 60_000

/**
 * Zod schema for ssh_journal_query tool input.
 * Provides runtime validation and type safety.
 */
export const sshJournalQuerySchema = z.object({
  sourceId: z.string().optional(),
  host: z.string().min(1).max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/, 'Invalid hostname format'),
  username: z.string().min(1).max(32).regex(/^[a-zA-Z0-9._-]+$/, 'Invalid username format'),
  since: z.string().min(1).max(100).regex(/^[a-zA-Z0-9:\-'" ]+$/, 'Invalid since format'),
  until: z.string().max(100).regex(/^[a-zA-Z0-9:\-'" ]*$/).optional(),
  cursor: z.string().max(500).optional(),
  port: z.number().int().positive().max(65535).optional(),
  units: z.array(z.string().max(255).regex(/^[a-zA-Z0-9._@-]+$/)).max(10).optional(),
  priorities: z.array(z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'])).max(8).optional(),
  limit: z.number().int().positive().max(100000).optional(),
  follow: z.boolean().optional(),
})

/**
 * Tool output truncation limit (context safety).
 * Large outputs are stored as artifacts with reference returned.
 */
const MAX_TOOL_OUTPUT = 15000  // characters

/**
 * SSH journalctl query tool executor.
 *
 * Executes SSH + journalctl using shared allowlisted command builder.
 * Streams output chunks via context.onChunk for real-time feedback.
 *
 * @param input - Validated tool input
 * @param context - Tool execution context (sessionId, toolCallId, abort signal, chunk callback)
 * @returns Tool result with output or error
 */
async function executeSshJournalQuery(
  input: SshJournalQueryInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { sessionId, toolCallId, signal, onChunk } = context

  // Build allowlisted command
  const command = buildSshJournalctlCommand(input)
  log.info(`[agent-runtime:${sessionId}] Executing ssh_journal_query:`, {
    toolCallId,
    host: input.host,
    display: command.display,
  })

  // Spawn SSH process (main process only, never renderer)
  const sshProcess = spawn('ssh', command.args, {
    shell: false,  // Prevent command injection
    env: process.env,  // Inherit user environment (ssh-agent, HOME, etc.)
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let outputBuffer = ''
  let stderrBuffer = ''

  // Stream stdout chunks
  const stdoutChunks: Promise<void> = new Promise((resolve) => {
    sshProcess.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8')
      outputBuffer += chunk

      // Stream chunk to renderer (truncated if needed)
      if (chunk.length > 1000) {
        onChunk(chunk.slice(0, 1000) + '...[truncated]')
      } else {
        onChunk(chunk)
      }
    })

    sshProcess.stdout.on('end', resolve)
  })

  // Capture stderr
  const stderrChunks: Promise<void> = new Promise((resolve) => {
    sshProcess.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString('utf-8')
    })

    sshProcess.stderr.on('end', resolve)
  })

  try {
    await runOrchestratedOperation({
      operation: 'SSH journal query',
      signal,
      timeoutMs: SSH_JOURNAL_QUERY_TIMEOUT_MS,
      execute: async (executionSignal) => {
        const abortHandler = () => {
          if (!sshProcess.killed) {
            log.info(`[agent-runtime:${sessionId}] Killing ssh_journal_query via abort:`, { toolCallId })
            sshProcess.kill('SIGTERM')
            setTimeout(() => {
              if (!sshProcess.killed) {
                sshProcess.kill('SIGKILL')
              }
            }, 2000)
          }
        }

        if (executionSignal.aborted) {
          abortHandler()
          throw new Error('Tool execution cancelled')
        }

        executionSignal.addEventListener('abort', abortHandler, { once: true })
        try {
          await Promise.all([
            new Promise<void>((resolve, reject) => {
              sshProcess.on('exit', (code, _exitSignal) => {
                if (code === 0) {
                  resolve()
                } else {
                  const classification = classifySshError(stderrBuffer)
                  if (classification.level === 'warning') {
                    log.warn(`[agent-runtime:${sessionId}] Non-fatal warning:`, classification.message)
                    resolve()
                  } else {
                    reject(new Error(classification.message))
                  }
                }
              })

              sshProcess.on('error', (err) => {
                reject(new Error(`Failed to spawn SSH: ${err.message}`))
              })
            }),
            stdoutChunks,
            stderrChunks,
          ])
        } finally {
          executionSignal.removeEventListener('abort', abortHandler)
        }
      },
    })

    let finalOutput = outputBuffer
    let artifactId: string | undefined

    if (outputBuffer.length > MAX_TOOL_OUTPUT) {
      artifactId = `ssh-journal-${sessionId}-${toolCallId}-${String(Date.now())}`
      log.info(`[agent-runtime:${sessionId}] Output truncated (${String(outputBuffer.length)} chars), artifact:`, artifactId)
      finalOutput = outputBuffer.slice(0, MAX_TOOL_OUTPUT) + `\n\n...[truncated, see artifact ${artifactId}]`
    }

    return {
      output: finalOutput,
      artifactId,
    }

  } catch (error) {
    let message = 'Unknown error'
    if (error instanceof Error) {
      message = error.message
    }

    log.error(`[agent-runtime:${sessionId}] ssh_journal_query failed:`, message)
    return { error: message }
  } finally {
    if (!sshProcess.killed) {
      sshProcess.kill()
    }
  }
}

/**
 * Tool definition for ssh_journal_query.
 *
 * Registers the tool with the agent runtime, providing:
 * - Name and description for LLM consumption
 * - Zod schema for input validation
 * - Executor function for tool logic
 */
export const sshJournalQueryTool: ToolDefinition<SshJournalQueryInput> = {
  name: 'ssh_journal_query',

  description: `Query remote systemd journals via SSH. Returns log entries from Linux servers.

Parameters MUST be passed as top-level fields, NOT wrapped in an input string.
Example: { "host": "192.168.1.10", "username": "ubuntu", "since": "1 hour ago" }

Important notes:
- Requires SSH key access (uses system SSH identity)
- Limited journal access may require user to be in adm or systemd-journal group
- Connection timeouts may indicate VPN/firewall issues
- Output is truncated at 50k characters for context safety`,

  inputSchema: sshJournalQuerySchema,

  async execute(input: SshJournalQueryInput, context: ToolContext): Promise<ToolResult> {
    return executeSshJournalQuery(input, context)
  },
}
