#!/usr/bin/env node
import log from 'electron-log'
import {
  runRunbooksCli,
  type RunbookCliRuntime,
  type RunbookCliRuntimeOptions,
} from './runbooks-cli.js'
import { DesktopRunbookRuntime } from '@bitsentry-desktop/runbook-runtime'

log.transports.console.level = 'error'

void runRunbooksCli((options) => DesktopRunbookRuntime.create(options)).catch((error: unknown) => {
  let message = String(error)
  if (error instanceof Error) {
    message = error.message
  }
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
