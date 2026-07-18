import { mkdtemp, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { CliJson } from './cli-test-helpers.js'
import { createCliTestContext, removeTempDirWithRetry } from './cli-test-helpers.js'

type CliTestContext = ReturnType<typeof createCliTestContext>

interface SmokeRunbookIds {
  fastRunbookId: string
  slowRunbookId: string
  cancellableRunbookId: string
  parameterizedRunbookId: string
  timeoutRunbookId: string
  envSanitizedRunbookId: string
}

function isCliJson(value: unknown): value is CliJson {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asCliJson(value: unknown, context: string): CliJson {
  if (!isCliJson(value)) {
    throw new Error(`${context} did not return an object`)
  }

  return value
}

function getStringField(value: CliJson, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') {
    return ''
  }

  return field
}

function getRequiredStringField(value: CliJson, key: string, context: string): string {
  const field = getStringField(value, key)
  if (field === '') {
    throw new Error(`${context} did not return ${key}`)
  }

  return field
}

function getObjectField(value: CliJson, key: string, context: string): CliJson {
  const field = value[key]
  if (!isCliJson(field)) {
    throw new Error(`${context} did not return an object field named ${key}`)
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

function getFirstStepOutput(execution: CliJson): string {
  const steps = getStepRecords(execution)
  if (steps.length === 0) {
    return ''
  }

  const firstStep = steps[0]
  if (typeof firstStep.output !== 'string') {
    return ''
  }

  return firstStep.output
}

function assertCompletedExecution(execution: CliJson, context: string): void {
  if (execution.status !== 'completed') {
    throw new Error(`${context} did not complete successfully`)
  }
}

function assertExecutionOutputIncludes(
  execution: CliJson,
  marker: string,
  context: string,
): void {
  const output = getFirstStepOutput(execution)
  if (!output.includes(marker)) {
    throw new Error(context)
  }
}

async function importSmokeRunbooks(
  context: CliTestContext,
  userDataDir: string,
  tempRoot: string,
): Promise<SmokeRunbookIds> {
  const fastRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'fast-complete',
    {
      title: 'fast-complete',
      actions: [{
        type: 'shell',
        title: 'fast-complete',
        command: await context.createNodeCommand(
          tempRoot,
          'fast-complete',
          "setTimeout(() => { console.log('fast-complete') }, 1200)\n",
        ),
      }],
    },
  )
  const slowRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'slow-concurrency',
    {
      title: 'slow-concurrency',
      actions: [{
        type: 'shell',
        title: 'slow-concurrency',
        command: await context.createNodeCommand(
          tempRoot,
          'slow-concurrency',
          "setTimeout(() => { console.log('slow-finished') }, 4500)\n",
        ),
      }],
    },
  )
  const cancellableRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'slow-cancel',
    {
      title: 'slow-cancel',
      actions: [{
        type: 'shell',
        title: 'slow-cancel',
        command: await context.createNodeCommand(
          tempRoot,
          'slow-cancel',
          "setTimeout(() => { console.log('should-not-print') }, 12000)\n",
        ),
      }],
    },
  )
  const parameterizedRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'param-equals',
    {
      title: 'param-equals',
      actions: [{
        type: 'shell',
        title: 'param-equals',
        command: await context.createNodeCommand(
          tempRoot,
          'param-equals',
          "console.log(process.argv[2] ?? '')\n",
          ['{{token}}'],
        ),
        parameters: [
          {
            key: 'token',
            label: 'Token',
            required: true,
          },
        ],
      }],
    },
  )
  const timeoutRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'slow-timeout',
    {
      title: 'slow-timeout',
      actions: [{
        type: 'shell',
        title: 'slow-timeout',
        command: await context.createNodeCommand(
          tempRoot,
          'slow-timeout',
          "setTimeout(() => { console.log('timeout-finished') }, 2500)\n",
        ),
      }],
    },
  )
  const envSanitizedRunbookId = await context.importSingleRunbook(
    userDataDir,
    tempRoot,
    'env-sanitized',
    {
      title: 'env-sanitized',
      actions: [{
        type: 'shell',
        title: 'env-sanitized',
        command: await context.createNodeCommand(
          tempRoot,
          'env-sanitized',
          [
            "if (process.env.ELECTRON_RUN_AS_NODE) {",
            "  console.error(`unexpected ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE}`)",
            '  process.exit(10)',
            '}',
            "const nodePath = process.env.NODE_PATH ?? ''",
            "if (nodePath.includes('app.asar.unpacked')) {",
            "  console.error(`unexpected NODE_PATH=${nodePath}`)",
            '  process.exit(11)',
            '}',
            "if (nodePath === '') {",
            "  console.log('env-sanitized:empty')",
            "} else {",
            "  console.log('env-sanitized:present')",
            "}",
            '',
          ].join('\n'),
        ),
      }],
    },
  )

  return {
    fastRunbookId,
    slowRunbookId,
    cancellableRunbookId,
    parameterizedRunbookId,
    timeoutRunbookId,
    envSanitizedRunbookId,
  }
}

async function assertRunbooksListed(
  context: CliTestContext,
  userDataDir: string,
): Promise<void> {
  const listed = await context.runCliJson(userDataDir, ['runbooks', 'list'])
  if (!Array.isArray(listed) || listed.length < 6) {
    throw new Error('Runbook list did not return the imported runbooks')
  }
}

async function assertExportWorks(
  context: CliTestContext,
  userDataDir: string,
  tempRoot: string,
  runbookIds: SmokeRunbookIds,
): Promise<void> {
  const exportPath = path.join(tempRoot, 'exported-runbooks.yaml')
  const exportResult = await context.runCliJson(userDataDir, [
    'runbooks',
    'export',
    '--runbook-id',
    runbookIds.fastRunbookId,
    '--runbook-id',
    runbookIds.slowRunbookId,
    '--output',
    exportPath,
  ])
  if (Array.isArray(exportResult) || exportResult.ok !== true) {
    throw new Error('Runbook export did not report success')
  }

  const exportedYaml = await readFile(exportPath, 'utf-8')
  if (
    !exportedYaml.includes('format: bitsentry.runbooks.export') ||
    !exportedYaml.includes('fast-complete') ||
    !exportedYaml.includes('slow-concurrency')
  ) {
    throw new Error('Exported YAML did not contain the expected runbooks')
  }
}

async function assertForegroundExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
): Promise<void> {
  const waited = await context.runCliJson(userDataDir, [
    'runbooks',
    'execute',
    '--runbook-id',
    runbookId,
    '--wait',
  ])
  const waitedPayload = asCliJson(waited, 'Foreground wait response')
  const waitedExecution = getObjectField(waitedPayload, 'execution', 'Foreground wait response')
  assertCompletedExecution(waitedExecution, 'Foreground wait execution')
  assertExecutionOutputIncludes(
    waitedExecution,
    'fast-complete',
    'Foreground wait execution did not record the expected shell output',
  )
}

async function assertParameterizedExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
): Promise<void> {
  const parameterized = await context.runCliJson(userDataDir, [
    'runbooks',
    'execute',
    '--runbook-id',
    runbookId,
    '--param=token=value=with=equals',
    '--wait',
  ])
  const parameterizedPayload = asCliJson(parameterized, 'Parameterized execution response')
  const parameterizedExecution = getObjectField(
    parameterizedPayload,
    'execution',
    'Parameterized execution response',
  )
  assertCompletedExecution(parameterizedExecution, 'Parameterized execution with inline equals')
  assertExecutionOutputIncludes(
    parameterizedExecution,
    'value=with=equals',
    'Parameterized execution did not preserve equals signs in the inline flag value',
  )
}

async function assertTimedOutExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
): Promise<void> {
  const timedOut = await context.runCliJson(userDataDir, [
    'runbooks',
    'execute',
    '--runbook-id',
    runbookId,
    '--wait',
    '--timeout-ms',
    '250',
  ])
  const timedOutPayload = asCliJson(timedOut, 'Timed-out wait response')
  const timedOutExecutionId = getRequiredStringField(
    timedOutPayload,
    'executionId',
    'Timed-out wait response',
  )
  const timedOutExecution = getObjectField(timedOutPayload, 'execution', 'Timed-out wait response')
  if (timedOutPayload.timedOut !== true || timedOutExecution.status !== 'running') {
    throw new Error('Timed-out wait execution did not report a running snapshot with timedOut=true')
  }

  const resumedExecution = await context.waitForExecution(
    userDataDir,
    timedOutExecutionId,
    20_000,
  )
  if (resumedExecution.status !== 'completed') {
    throw new Error(`Expected timed-out execution to complete later, received ${String(resumedExecution.status)}`)
  }
  assertExecutionOutputIncludes(
    resumedExecution,
    'timeout-finished',
    'Timed-out execution did not continue running after the CLI wait returned',
  )
}

async function assertEnvironmentSanitizedExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
): Promise<void> {
  const envSanitized = await context.runCliJson(userDataDir, [
    'runbooks',
    'execute',
    '--runbook-id',
    runbookId,
    '--wait',
  ])
  const envSanitizedPayload = asCliJson(envSanitized, 'Environment sanitization response')
  const envSanitizedExecution = getObjectField(
    envSanitizedPayload,
    'execution',
    'Environment sanitization response',
  )
  assertCompletedExecution(envSanitizedExecution, 'Shell execution environment sanitization check')
  assertExecutionOutputIncludes(
    envSanitizedExecution,
    'env-sanitized:',
    'Shell execution environment sanitization check did not capture the expected output',
  )
}

async function startDetachedExecution(
  context: CliTestContext,
  userDataDir: string,
  runbookId: string,
  responseContext: string,
): Promise<string> {
  const response = await context.runCliJson(userDataDir, [
    'runbooks',
    'execute',
    '--runbook-id',
    runbookId,
  ])
  const payload = asCliJson(response, responseContext)
  return getRequiredStringField(payload, 'executionId', responseContext)
}

async function assertDetachedExecutionFlow(
  context: CliTestContext,
  userDataDir: string,
  runbookIds: SmokeRunbookIds,
): Promise<void> {
  const runningExecutionId = await startDetachedExecution(
    context,
    userDataDir,
    runbookIds.slowRunbookId,
    'First detached execution response',
  )
  const cancellableExecutionId = await startDetachedExecution(
    context,
    userDataDir,
    runbookIds.cancellableRunbookId,
    'Second detached execution response',
  )

  const cancellationResult = await context.runCliJson(userDataDir, [
    'runbooks',
    'cancel',
    '--execution-id',
    cancellableExecutionId,
  ])
  if (
    Array.isArray(cancellationResult) ||
    typeof cancellationResult.executionId !== 'string'
  ) {
    throw new Error('Cancellation response did not include an execution id')
  }

  const completedExecution = await context.waitForExecution(
    userDataDir,
    runningExecutionId,
    20_000,
  )
  if (completedExecution.status !== 'completed') {
    throw new Error(`Expected concurrent execution to complete, received ${String(completedExecution.status)}`)
  }
  assertExecutionOutputIncludes(
    completedExecution,
    'slow-finished',
    'Concurrent execution did not capture the expected shell output',
  )

  const cancelledExecution = await context.waitForExecution(
    userDataDir,
    cancellableExecutionId,
    20_000,
  )
  if (cancelledExecution.status !== 'cancelled') {
    throw new Error(`Expected cancelled execution, received ${String(cancelledExecution.status)}`)
  }
  if (cancelledExecution.completionReason !== 'user_cancelled') {
    throw new Error(
      `Expected cancellation reason user_cancelled, received ${String(cancelledExecution.completionReason)}`,
    )
  }
  const cancelledSteps = getStepRecords(cancelledExecution)
  if (cancelledSteps.length === 0) {
    throw new Error('Cancelled execution did not retain any step state')
  }
  const cancelledOutput = getFirstStepOutput(cancelledExecution)
  if (cancelledOutput.includes('should-not-print')) {
    throw new Error('Cancelled execution unexpectedly captured the late shell output')
  }
}

async function deleteImportedRunbooks(
  context: CliTestContext,
  userDataDir: string,
  runbookIds: SmokeRunbookIds,
): Promise<void> {
  const ids = [
    runbookIds.fastRunbookId,
    runbookIds.slowRunbookId,
    runbookIds.cancellableRunbookId,
    runbookIds.parameterizedRunbookId,
    runbookIds.timeoutRunbookId,
    runbookIds.envSanitizedRunbookId,
  ]

  for (const runbookId of ids) {
    const deleted = await context.runCliJson(userDataDir, [
      'runbooks',
      'delete',
      '--runbook-id',
      runbookId,
    ])
    if (Array.isArray(deleted) || deleted.ok !== true) {
      throw new Error(`Delete did not report success for runbook ${runbookId}`)
    }
  }

  const listedAfterDelete = await context.runCliJson(userDataDir, ['runbooks', 'list'])
  if (!Array.isArray(listedAfterDelete) || listedAfterDelete.length !== 0) {
    throw new Error('Runbooks were not fully deleted by the CLI smoke test')
  }
}

export async function runCliSmokeTest(desktopDir: string): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-cli-smoke.'))
  const userDataDir = path.join(tempRoot, 'user-data')
  const context = createCliTestContext(desktopDir)

  try {
    await context.assertCliBundleExists()
    const runbookIds = await importSmokeRunbooks(context, userDataDir, tempRoot)
    await assertRunbooksListed(context, userDataDir)
    await assertExportWorks(context, userDataDir, tempRoot, runbookIds)
    await assertForegroundExecution(context, userDataDir, runbookIds.fastRunbookId)
    await assertParameterizedExecution(context, userDataDir, runbookIds.parameterizedRunbookId)
    await assertTimedOutExecution(context, userDataDir, runbookIds.timeoutRunbookId)
    await assertEnvironmentSanitizedExecution(context, userDataDir, runbookIds.envSanitizedRunbookId)
    await assertDetachedExecutionFlow(context, userDataDir, runbookIds)
    await deleteImportedRunbooks(context, userDataDir, runbookIds)

    process.stdout.write('Desktop CLI smoke test passed.\n')
  } finally {
    await removeTempDirWithRetry(tempRoot)
  }
}
