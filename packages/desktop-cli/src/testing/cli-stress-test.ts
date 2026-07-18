import { mkdtemp } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { CliJson } from './cli-test-helpers.js'
import { createCliTestContext, removeTempDirWithRetry } from './cli-test-helpers.js'

type CliTestContext = ReturnType<typeof createCliTestContext>

interface StartedExecution {
  label: string
  delayMs: number
  executionId: string
}

function asCliJson(value: unknown, context: string): CliJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} did not return an object`)
  }

  return value as CliJson
}

function getStringField(value: CliJson, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') {
    return ''
  }

  return field
}

function formatStringField(value: CliJson, key: string, fallback: string): string {
  const field = getStringField(value, key)
  if (field === '') {
    return fallback
  }

  return field
}

function getStepRecords(execution: CliJson): Array<Record<string, unknown>> {
  const { steps } = execution
  if (!Array.isArray(steps)) {
    return []
  }

  return steps.filter(
    (step): step is Record<string, unknown> =>
      step !== null &&
      typeof step === 'object' &&
      !Array.isArray(step),
  )
}

function getStepString(steps: Array<Record<string, unknown>>, key: string): string {
  if (steps.length === 0) {
    return ''
  }

  const firstStep = steps[0]
  const value = firstStep[key]
  if (typeof value !== 'string') {
    return ''
  }

  return value
}

function assertCompletedExecution(
  execution: CliJson,
  label: string,
  delayMs: number,
): void {
  const completionReason = formatStringField(execution, 'completionReason', 'unknown')
  const steps = getStepRecords(execution)
  const stepError = getStepString(steps, 'error')
  const stepOutput = getStepString(steps, 'output')

  if (execution.status !== 'completed') {
    throw new Error(
      `Expected ${label} to complete, received ${String(execution.status)} ` +
        `(completionReason=${completionReason}, stepError=${JSON.stringify(stepError)}, ` +
        `stepOutput=${JSON.stringify(stepOutput.slice(-240))})`,
    )
  }

  if (execution.completionReason !== 'success') {
    throw new Error(
      `Expected ${label} completion reason success, received ${completionReason} ` +
        `(stepError=${JSON.stringify(stepError)}, stepOutput=${JSON.stringify(stepOutput.slice(-240))})`,
    )
  }
  const output = getStepString(steps, 'output')
  if (!output.includes(`parallel:${label}:${String(delayMs)}`)) {
    throw new Error(`Execution output for ${label} did not contain the expected marker`)
  }
}

async function importStressRunbook(
  context: CliTestContext,
  userDataDir: string,
  tempRoot: string,
): Promise<string> {
  return context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'parallel-params',
    {
      title: 'parallel-params',
      description: 'Parallel parameterized CLI execution stress test',
      actions: [{
        type: 'shell',
        title: 'parallel-params',
        command: await context.createNodeCommand(
          tempRoot,
          'parallel-params',
          [
            "const [label = '', delayValue = '0'] = process.argv.slice(2)",
            'const delayMs = Number.parseInt(delayValue, 10)',
            'if (!Number.isFinite(delayMs)) {',
            "  console.error('invalid delay')",
            '  process.exit(2)',
            '}',
            'setTimeout(() => {',
            '  console.log(`parallel:${label}:${delayMs}`)',
            '}, delayMs)',
            '',
          ].join('\n'),
          ['{{label}}', '{{delay_ms}}'],
        ),
        parameters: [
          {
            key: 'label',
            label: 'Label',
            required: true,
          },
          {
            key: 'delay_ms',
            label: 'Delay (ms)',
            required: true,
          },
        ],
      }],
    },
  )
}

async function startExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
  label: string,
  delayMs: number,
): Promise<StartedExecution> {
  const started = asCliJson(
    await context.runCliJson(userDataDir, [
      'runbooks',
      'execute',
      '--runbook-id',
      runbookId,
      '--param',
      `label=${label}`,
      '--param',
      `delay_ms=${String(delayMs)}`,
    ]),
    `Execution start for ${label}`,
  )

  const executionId = getStringField(started, 'executionId')
  if (executionId === '') {
    throw new Error(`Execution start for ${label} did not return an execution id`)
  }

  return { label, delayMs, executionId }
}

async function startParallelExecutions(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
): Promise<StartedExecution[]> {
  const parallelInputs = [
    { label: 'alpha', delayMs: 1_200 },
    { label: 'bravo', delayMs: 1_450 },
    { label: 'charlie', delayMs: 1_700 },
    { label: 'delta', delayMs: 1_950 },
    { label: 'echo', delayMs: 2_200 },
  ]

  return Promise.all(
    parallelInputs.map(({ label, delayMs }) =>
      startExecution(context, userDataDir, runbookId, label, delayMs),
    ),
  )
}

function assertUniqueExecutionIds(startedExecutions: StartedExecution[]): void {
  const uniqueExecutionIds = new Set(startedExecutions.map(({ executionId }) => executionId))
  if (uniqueExecutionIds.size !== startedExecutions.length) {
    throw new Error('Parallel executions returned duplicate execution ids')
  }
}

async function cancelExecution(
  context: CliTestContext,
  userDataDir: string,
  execution: StartedExecution,
): Promise<void> {
  const cancelled = asCliJson(
    await context.runCliJson(userDataDir, [
      'runbooks',
      'cancel',
      '--execution-id',
      execution.executionId,
    ]),
    'Cancellation response',
  )
  if (cancelled.executionId !== execution.executionId) {
    throw new Error('Cancellation response did not echo the expected execution id')
  }
}

async function assertParallelExecutionsCompleted(
  context: CliTestContext,
  userDataDir: string,
  startedExecutions: StartedExecution[],
): Promise<void> {
  const completedExecutions = await Promise.all(
    startedExecutions.map(async ({ label, delayMs, executionId }) => ({
      label,
      delayMs,
      execution: await context.waitForExecution(userDataDir, executionId, 20_000),
    })),
  )
  for (const { label, delayMs, execution } of completedExecutions) {
    assertCompletedExecution(execution, label, delayMs)
  }
}

async function assertCancelledExecution(
  context: CliTestContext,
  userDataDir: string,
  executionId: string,
): Promise<void> {
  const cancelledExecution = await context.waitForExecution(
    userDataDir,
    executionId,
    20_000,
  )
  if (cancelledExecution.status !== 'cancelled') {
    const completionReason = formatStringField(cancelledExecution, 'completionReason', 'unknown')
    throw new Error(
      `Expected cancelled execution status, received ${String(cancelledExecution.status)} ` +
        `(completionReason=${completionReason}, ` +
        `steps=${JSON.stringify(cancelledExecution.steps ?? [])})`,
    )
  }
  if (cancelledExecution.completionReason !== 'user_cancelled') {
    throw new Error(
      `Expected cancellation reason user_cancelled, received ${String(cancelledExecution.completionReason)}`,
    )
  }

  const cancelledSteps = getStepRecords(cancelledExecution)
  const cancelledOutput = getStepString(cancelledSteps, 'output')
  if (cancelledOutput.includes('parallel:cancelled:10000')) {
    throw new Error('Cancelled parallel execution unexpectedly captured terminal output')
  }
}

async function assertExportDeleteAndCleanup(
  context: CliTestContext,
  userDataDir: string,
  tempRoot: string,
  runbookId: string,
): Promise<void> {
  const exportedPath = path.join(tempRoot, 'parallel-params-export.yaml')
  const exported = asCliJson(
    await context.runCliJson(userDataDir, [
      'runbooks',
      'export',
      '--runbook-id',
      runbookId,
      '--output',
      exportedPath,
    ]),
    'Export response',
  )
  if (exported.ok !== true) {
    throw new Error('Parameterized runbook export did not report success')
  }

  const deleted = asCliJson(
    await context.runCliJson(userDataDir, [
      'runbooks',
      'delete',
      '--runbook-id',
      runbookId,
    ]),
    'Delete response',
  )
  if (deleted.ok !== true) {
    throw new Error('Parameterized runbook delete did not report success')
  }

  const listedAfterDelete = await context.runCliJson(userDataDir, ['runbooks', 'list'])
  if (!Array.isArray(listedAfterDelete) || listedAfterDelete.length !== 0) {
    throw new Error('Runbook store was not empty after the stress test cleanup')
  }
}

export async function runCliStressTest(desktopDir: string): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-cli-stress.'))
  const userDataDir = path.join(tempRoot, 'user-data')
  const context = createCliTestContext(desktopDir)

  try {
    await context.assertCliBundleExists()
    const runbookId = await importStressRunbook(context, userDataDir, tempRoot)
    const startedExecutions = await startParallelExecutions(context, userDataDir, runbookId)
    assertUniqueExecutionIds(startedExecutions)

    const cancellableExecution = await startExecution(
      context,
      userDataDir,
      runbookId,
      'cancelled',
      10_000,
    )
    await cancelExecution(context, userDataDir, cancellableExecution)
    await assertParallelExecutionsCompleted(context, userDataDir, startedExecutions)
    await assertCancelledExecution(context, userDataDir, cancellableExecution.executionId)
    await assertExportDeleteAndCleanup(context, userDataDir, tempRoot, runbookId)

    process.stdout.write('Desktop CLI stress test passed.\n')
  } finally {
    await removeTempDirWithRetry(tempRoot)
  }
}
