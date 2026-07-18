import { spawn } from 'child_process'
import type { ChildProcessByStdio } from 'child_process'
import type { Readable } from 'stream'
import { z } from 'zod'
import type { ToolContext, ToolDefinition, ToolResult } from '../types'
import {
  OrchestrationError,
  runOrchestratedOperation,
} from '../shared/effect-orchestration'

const CLI_WRAPPER_NODE_PATH_ENV = 'BITSENTRY_CLI_WRAPPER_NODE_PATH'
const log = console
type ShellChildProcess = ChildProcessByStdio<null, Readable, Readable>

export const executeShellCommandSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300000).nullable().optional(),
  maxOutputBytes: z.number().int().positive().max(1_000_000).optional(),
  treatTimeoutAsSuccess: z.boolean().optional(),
  treatMaxOutputAsSuccess: z.boolean().optional(),
  terminateOnMaxOutput: z.boolean().optional(),
})

type ExecuteShellCommandInput = z.infer<typeof executeShellCommandSchema>

interface ShellExecutionState {
  outputBuffer: string
  stderrBuffer: string
  timedOut: boolean
  outputLimitReached: boolean
  forcedTermination: boolean
}

function resolveTimeoutMs(value: number | null | undefined): number | null {
  if (value === null) {
    return null
  }

  return value ?? 30_000
}

function createChildEnv(): NodeJS.ProcessEnv {
  const {
    ELECTRON_RUN_AS_NODE: _electronRunAsNode,
    [CLI_WRAPPER_NODE_PATH_ENV]: wrapperNodePath,
    ...childEnv
  } = process.env

  if (
    typeof wrapperNodePath === 'string' &&
    wrapperNodePath.length > 0 &&
    childEnv.NODE_PATH === wrapperNodePath
  ) {
    const { NODE_PATH: _nodePath, ...withoutNodePath } = childEnv
    return withoutNodePath
  }

  return childEnv
}

function trimToLimit(value: string, maxOutputBytes: number): string {
  if (value.length <= maxOutputBytes) {
    return value
  }

  return value.slice(value.length - maxOutputBytes)
}

function terminateChildProcess(
  child: ShellChildProcess,
  state: ShellExecutionState,
): void {
  if (state.forcedTermination || child.killed) {
    return
  }

  state.forcedTermination = true
  child.kill('SIGTERM')
  setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL')
    }
  }, 2000)
}

function appendOutputChunk(input: {
  chunk: string
  stream: 'stdout' | 'stderr'
  state: ShellExecutionState
  maxOutputBytes: number
}): void {
  const { chunk, stream, state, maxOutputBytes } = input
  if (state.outputBuffer.length + state.stderrBuffer.length + chunk.length > maxOutputBytes) {
    state.outputLimitReached = true
  }
  if (stream === 'stdout') {
    state.outputBuffer = trimToLimit(state.outputBuffer + chunk, maxOutputBytes)
    return
  }

  state.stderrBuffer = trimToLimit(state.stderrBuffer + chunk, maxOutputBytes)
}

function createOutputListener(input: {
  child: ShellChildProcess
  stream: 'stdout' | 'stderr'
  state: ShellExecutionState
  maxOutputBytes: number
  terminateOnMaxOutput: boolean
  sessionId: string
  toolCallId: string
  onChunk: (chunk: string) => void
  terminateChild: () => void
}): Promise<void> {
  return new Promise<void>((resolve) => {
    let stream = input.child.stdout
    if (input.stream === 'stderr') {
      stream = input.child.stderr
    }
    stream.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8')
      appendOutputChunk({
        chunk,
        stream: input.stream,
        state: input.state,
        maxOutputBytes: input.maxOutputBytes,
      })
      input.onChunk(chunk)
      if (input.terminateOnMaxOutput && input.state.outputLimitReached) {
        log.warn(`[agent-runtime:${input.sessionId}] Shell command output limit reached`, {
          toolCallId: input.toolCallId,
          maxOutputBytes: input.maxOutputBytes,
        })
        input.terminateChild()
      }
    })
    stream.on('end', resolve)
  })
}

function errorOutputForExit(stderrBuffer: string, code: number | null): string {
  const trimmed = stderrBuffer.trim()
  if (trimmed.length > 0) {
    return trimmed
  }

  if (code === null) {
    return 'Command exited with code unknown'
  }

  return `Command exited with code ${String(code)}`
}

function optionalOutput(value: string): string | undefined {
  if (value.length > 0) {
    return value
  }

  return undefined
}

async function executeShellCommand(
  input: ExecuteShellCommandInput,
  context: ToolContext,
): Promise<ToolResult> {
  const { sessionId, toolCallId, signal, onChunk } = context
  const timeoutMs = resolveTimeoutMs(input.timeoutMs)
  const maxOutputBytes = input.maxOutputBytes ?? 100_000
  const terminateOnMaxOutput = input.terminateOnMaxOutput ?? true
  const childEnv = createChildEnv()

  const child = spawn(input.command, {
    shell: true,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const state: ShellExecutionState = {
    outputBuffer: '',
    stderrBuffer: '',
    timedOut: false,
    outputLimitReached: false,
    forcedTermination: false,
  }

  const terminateChild = (): void => {
    terminateChildProcess(child, state)
  }

  const stdoutDone = createOutputListener({
    child,
    stream: 'stdout',
    state,
    maxOutputBytes,
    terminateOnMaxOutput,
    sessionId,
    toolCallId,
    onChunk,
    terminateChild,
  })
  const stderrDone = createOutputListener({
    child,
    stream: 'stderr',
    state,
    maxOutputBytes,
    terminateOnMaxOutput,
    sessionId,
    toolCallId,
    onChunk,
    terminateChild,
  })

  try {
    await runOrchestratedOperation({
      operation: 'Shell command',
      signal,
      timeoutMs,
      execute: async (executionSignal) => {
        const abortHandler = () => {
          log.info(`[agent-runtime:${sessionId}] Killing shell command via abort`, {
            toolCallId,
          })
          terminateChild()
        }

        if (executionSignal.aborted) {
          abortHandler()
          throw new Error('Tool execution cancelled')
        }

        executionSignal.addEventListener('abort', abortHandler, { once: true })
        try {
          await Promise.all([
            new Promise<void>((resolve, reject) => {
              child.on('exit', (code) => {
                if (state.outputLimitReached) {
                  if (!terminateOnMaxOutput || input.treatMaxOutputAsSuccess === true) {
                    resolve()
                    return
                  }
                  reject(new Error(`Command output exceeded ${String(maxOutputBytes)} bytes`))
                  return
                }
                if (code === 0) {
                  resolve()
                  return
                }
                reject(new Error(errorOutputForExit(state.stderrBuffer, code)))
              })

              child.on('error', (error) => {
                reject(new Error(`Failed to spawn command: ${error.message}`))
              })
            }),
            stdoutDone,
            stderrDone,
          ])
        } finally {
          executionSignal.removeEventListener('abort', abortHandler)
        }
      },
    })

    const output = thisCommandOutput(
      state.outputBuffer,
      state.stderrBuffer,
      state.timedOut,
      state.outputLimitReached,
      timeoutMs,
      maxOutputBytes,
      terminateOnMaxOutput,
    )
    if (output.length > 0) {
      return { output }
    }

    return { output: 'Command completed with no output.' }
  } catch (error) {
    if (error instanceof OrchestrationError && error.kind === 'timeout') {
      state.timedOut = true
      log.warn(`[agent-runtime:${sessionId}] Shell command timed out`, {
        toolCallId,
        timeoutMs,
      })
      if (input.treatTimeoutAsSuccess === true) {
        const output = thisCommandOutput(
          state.outputBuffer,
          state.stderrBuffer,
          state.timedOut,
          state.outputLimitReached,
          timeoutMs,
          maxOutputBytes,
          terminateOnMaxOutput,
        )
        return { output: optionalOutput(output) ?? 'Command timed out with no output.' }
      }
    }

    const output = thisCommandOutput(
      state.outputBuffer,
      state.stderrBuffer,
      state.timedOut,
      state.outputLimitReached,
      timeoutMs,
      maxOutputBytes,
      terminateOnMaxOutput,
    )
    let errorMessage = 'Unknown shell execution error'
    if (error instanceof Error) {
      errorMessage = error.message
    }

    return {
      error: errorMessage,
      output: optionalOutput(output),
    }
  } finally {
    terminateChild()
  }
}

function thisCommandOutput(
  stdout: string,
  stderr: string,
  timedOut: boolean,
  outputLimitReached: boolean,
  timeoutMs: number | null,
  maxOutputBytes: number,
  terminateOnMaxOutput: boolean,
): string {
  let base = stdout
  if (base.length === 0) {
    base = stderr
  }
  const notes: string[] = []

  if (timedOut && typeof timeoutMs === 'number') {
    notes.push(`[BitSentry stopped this command after ${String(timeoutMs)}ms to avoid a hung runbook.]`)
  }

  if (outputLimitReached) {
    notes.push(outputLimitNote(terminateOnMaxOutput, maxOutputBytes))
  }

  if (notes.length === 0) {
    return base
  }

  return [base, ...notes].filter((part) => part.length > 0).join('\n')
}

function outputLimitNote(
  terminateOnMaxOutput: boolean,
  maxOutputBytes: number,
): string {
  if (terminateOnMaxOutput) {
    return `[BitSentry stopped this command after capturing ${String(maxOutputBytes)} bytes of output.]`
  }

  return `[BitSentry is showing only the most recent ${String(maxOutputBytes)} bytes of output while the command keeps running.]`
}

export const executeShellCommandTool: ToolDefinition<ExecuteShellCommandInput> = {
  name: 'execute_shell_command',
  description: 'Execute a local shell command in the desktop main process.',
  inputSchema: executeShellCommandSchema,
  execute: executeShellCommand,
}
