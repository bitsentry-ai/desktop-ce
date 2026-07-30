#!/usr/bin/env node
import log from 'electron-log'
import {
  runRunbooksCli,
} from './runbooks-cli.js'
import { createLocalRunbookExecutionClient } from '../runtime/local-runbook-execution-host.js'
import { DesktopRunbookRuntime } from '@bitsentry-desktop/runbook-runtime'

log.transports.console.level = 'error'

void runRunbooksCli((options) => createLocalRunbookExecutionClient({
  userDataPath: options?.userDataPath,
  createHeadlessRuntime: () => DesktopRunbookRuntime.create(options),
})).catch((error: unknown) => {
  let message = String(error)
  if (error instanceof Error) {
    message = error.message
  }
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
