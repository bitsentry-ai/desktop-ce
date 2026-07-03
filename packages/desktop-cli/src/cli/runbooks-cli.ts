import process from 'process'
import os from 'os'
import path from 'path'
import { access, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { parse as parseYaml } from 'yaml'

import {
  createDesktopNodePluginRuntimeService,
  resolveDesktopPluginDirectories,
} from '@bitsentry-ce/core/features/plugins/node'
import type { ErrorSourceType } from '@bitsentry-ce/core/features/error-sources'
import type {
  DesktopPluginDescriptor,
  DesktopPluginFieldDefinition,
  DesktopPluginStoredAuthRecord,
  DesktopPluginStoredAuthValue,
} from '@bitsentry-ce/core/features/plugins'

import { LocalPluginCredentialsStore } from '../runtime/plugin-credentials-store'
import { getRuntimeUserDataPath } from '../runtime/runtime-paths'

type ParsedArgs = {
  positionals: string[]
  flags: Map<string, string[]>
}

export interface RunbookCliExecuteInput {
  runbookId: string
  parameterValues?: Record<string, string>
  incidentThreadId?: string
  triggerContext?: {
    entrypoint: 'runbooks' | 'incident_detail' | 'incident_workspace' | 'diagnosis'
    needId?: string
    needLabel?: string
    sourceId?: string
    sourceName?: string
    sourceType?: ErrorSourceType
    incidentThreadId?: string
  }
}

export interface RunbookCliRuntime {
  destroy(): Promise<void>
  listRunbooks(): Promise<unknown[]>
  deleteRunbook(runbookId: string): Promise<{ ok: true }>
  exportRunbooks(runbookIds: string[], includeGlobals?: boolean): Promise<unknown>
  exportRunbooksToFile(
    filePath: string,
    runbookIds: string[],
    includeGlobals?: boolean,
  ): Promise<{ ok: true; filePath: string; count: number }>
  importRunbooksFromFile(filePath: string, options?: unknown): Promise<unknown>
  executeRunbook(
    input: RunbookCliExecuteInput,
  ): Promise<{ executionId: string; resultId: string }>
  getExecution(executionId: string): Promise<Record<string, unknown> | null>
  cancelExecution(executionId: string): Promise<void>
  waitForExecution(
    executionId: string,
    options?: { pollIntervalMs?: number; timeoutMs?: number },
  ): Promise<Record<string, unknown> | null>
}

export interface RunbookCliRuntimeOptions {
  userDataPath?: string
  staleHeartbeatGraceMs?: number
}

export type RunbookCliRuntimeFactory = (
  options?: RunbookCliRuntimeOptions,
) => Promise<RunbookCliRuntime>

type RunbookImportConflictPolicy = 'duplicate' | 'skip' | 'overwrite'
type RunbooksCommandContext = {
  runtime: RunbookCliRuntime
  args: ParsedArgs
  asJson: boolean
}
type RunbooksCommandHandler = (context: RunbooksCommandContext) => Promise<void>
type PluginCommandContext = {
  args: ParsedArgs
  asJson: boolean
}
type PluginCommandHandler = (context: PluginCommandContext) => void | Promise<void>
type CliScope = 'runbooks' | 'plugin'
type ResolvedCliCommand = {
  scope: CliScope
  command: string
}
type PluginIndexEntry = {
  name: string
  artifactUrl: string
  description?: string
}

const DEFAULT_PLUGIN_INDEX_URL = 'https://plugins.bitsentry.ai/index.yaml'
const DEFAULT_PLUGIN_INDEX_ORIGIN = new URL(DEFAULT_PLUGIN_INDEX_URL).origin

const DETACHED_EXECUTION_START_TIMEOUT_MS = 15_000
const DETACHED_EXECUTION_START_POLL_MS = 50

function parseFlagToken(token: string): { key: string; inlineValue?: string } | null {
  const inlineSeparator = token.indexOf('=', 2)
  let rawKey = token.slice(2)
  let inlineValue: string | undefined
  if (inlineSeparator >= 0) {
    rawKey = token.slice(2, inlineSeparator)
    inlineValue = token.slice(inlineSeparator + 1)
  }

  const key = rawKey.trim()
  if (key === '') {
    return null
  }

  return { key, inlineValue }
}

function addFlagValue(flags: Map<string, string[]>, key: string, value: string): void {
  const existing = flags.get(key) ?? []
  existing.push(value)
  flags.set(key, existing)
}

function readSeparatedFlagValue(argv: string[], index: number): { value: string; nextIndex: number } {
  const next = argv[index + 1]
  if (index + 1 < argv.length && !next.startsWith('--')) {
    return { value: next, nextIndex: index + 1 }
  }

  return { value: 'true', nextIndex: index }
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string[]>()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const parsedFlag = parseFlagToken(token)
    if (parsedFlag === null) {
      continue
    }

    if (parsedFlag.inlineValue !== undefined) {
      addFlagValue(flags, parsedFlag.key, parsedFlag.inlineValue)
      continue
    }

    const separated = readSeparatedFlagValue(argv, index)
    addFlagValue(flags, parsedFlag.key, separated.value)
    index = separated.nextIndex
  }

  return { positionals, flags }
}

function getFlag(args: ParsedArgs, key: string): string | undefined {
  return args.flags.get(key)?.at(-1)
}

function getFlagValues(args: ParsedArgs, key: string): string[] {
  return args.flags.get(key) ?? []
}

function hasFlag(args: ParsedArgs, key: string): boolean {
  return args.flags.has(key)
}

function requiredFlag(args: ParsedArgs, key: string): string {
  const value = getFlag(args, key)
  if (value === undefined || value === '' || value === 'true') {
    throw new Error(`Missing required flag --${key}`)
  }
  return value
}

function parseBooleanFlag(args: ParsedArgs, key: string): boolean {
  return hasFlag(args, key) && getFlag(args, key) !== 'false'
}

function parseIntegerFlag(args: ParsedArgs, key: string): number | undefined {
  const value = getFlag(args, key)
  if (value === undefined || value === '' || value === 'true') {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for --${key}: ${value}`)
  }
  return parsed
}

function parseParameterValues(args: ParsedArgs): Record<string, string> | undefined {
  const entries = getFlagValues(args, 'param')
  if (entries.length === 0) {
    return undefined
  }

  const values: Record<string, string> = {}
  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new Error(`Invalid --param value "${entry}". Expected key=value.`)
    }
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (key === '') {
      throw new Error(`Invalid --param value "${entry}". Expected key=value.`)
    }
    values[key] = value
  }

  return values
}

function parseJsonObjectFlag(args: ParsedArgs, key: string): Record<string, unknown> {
  const value = getFlag(args, key)
  if (value === undefined || value === '' || value === 'true') {
    return {}
  }

  const parsed = JSON.parse(value) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--${key} must be a JSON object`)
  }

  return parsed as Record<string, unknown>
}

function printHelp(): void {
  process.stdout.write(`bitsentry CLI

Usage:
  bitsentry runbooks list [--json]
  bitsentry runbooks execute --runbook-id <id> [--param key=value]... [--wait] [--timeout-ms <ms>] [--json]
  bitsentry runbooks get-execution --execution-id <id> [--json]
  bitsentry runbooks cancel --execution-id <id> [--json]
  bitsentry runbooks delete --runbook-id <id> [--json]
  bitsentry runbooks export --runbook-id <id> [--runbook-id <id> ...] [--include-globals] [--output <file>] [--json]
  bitsentry runbooks import --file <path> [--conflict-policy duplicate|skip|overwrite] [--preserve-ids] [--include-globals] [--dry-run] [--json]
  bitsentry plugin list [--plugin-dir <path>] [--json]
  bitsentry plugin info <name> [--index-url <url>] [--plugin-dir <path>] [--json]
  bitsentry plugin install <name> [--index-url <url>] [--plugin-dir <path>] [--json]
  bitsentry plugin update <name> [--index-url <url>] [--plugin-dir <path>] [--json]
  bitsentry plugin remove <name> [--plugin-dir <path>] [--user-data-dir <path>] [--json]
  bitsentry plugin configure <name> --auth-json <json> [--user-data-dir <path>] [--json]
  bitsentry plugin show-config <name> [--reveal-secrets] [--user-data-dir <path>] [--json]
  bitsentry plugin clear-config <name> [--user-data-dir <path>] [--json]
  bitsentry plugin execute --plugin-id <id> --action-id <id> [--auth-json <json>] [--input-json <json>] [--plugin-dir <path>] [--json]

Global flags:
  --user-data-dir <path>   Override the desktop user-data directory.
  --plugin-dir <path>      Add a BitSentry code-plugin install/discovery directory.
  --index-url <url>        Override the first-party plugin index URL.
  --json                   Print machine-readable JSON output.
`)
}

function printOutput(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
    return
  }

  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`)
    return
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function getExecutionStatus(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const { status } = value as { status?: unknown }
  if (typeof status !== 'string') {
    return undefined
  }

  return status
}

function buildForwardedArgs(args: ParsedArgs): string[] {
  const forwarded: string[] = []

  for (const [key, values] of args.flags.entries()) {
    if (key === 'json' || key === 'wait') {
      continue
    }

    for (const value of values) {
      if (value === 'true') {
        forwarded.push(`--${key}`)
      } else {
        forwarded.push(`--${key}`, value)
      }
    }
  }

  return forwarded
}

async function startDetachedExecution(
  args: ParsedArgs,
): Promise<{ executionId: string; resultId: string; detached: boolean; workerPid: number }> {
  const cliScriptPath = path.resolve(process.argv[1] ?? '')

  const handshakeDir = await mkdtemp(path.join(os.tmpdir(), 'bitsentry-cli-exec.'))
  const startupFile = path.join(handshakeDir, 'startup.json')
  const detached = true
  const child = spawn(
    process.execPath,
    [
      cliScriptPath,
      'runbooks',
      'execute-worker',
      ...buildForwardedArgs(args),
      '--startup-file',
      startupFile,
    ],
    {
      detached,
      stdio: 'ignore',
      windowsHide: process.platform === 'win32',
      env: {
        ...process.env,
      },
    },
  )

  child.unref()

  try {
    const started = await waitForDetachedExecutionStart(child, startupFile)
    return {
      ...started,
      detached,
      workerPid: child.pid ?? -1,
    }
  } finally {
    await rm(handshakeDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function waitForDetachedExecutionStart(
  child: ReturnType<typeof spawn>,
  startupFile: string,
): Promise<{ executionId: string; resultId: string }> {
  const deadline = Date.now() + DETACHED_EXECUTION_START_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Detached execution worker exited before startup (code=${String(child.exitCode)})`,
      )
    }

    const started = await readDetachedExecutionStartFile(startupFile)
    if (started !== null) {
      return started
    }

    await new Promise((resolve) => setTimeout(resolve, DETACHED_EXECUTION_START_POLL_MS))
  }

  throw new Error('Detached execution worker did not report startup metadata in time')
}

async function readDetachedExecutionStartFile(
  startupFile: string,
): Promise<{ executionId: string; resultId: string } | null> {
  try {
    await access(startupFile)
  } catch {
    return null
  }

  try {
    const raw = await readFile(startupFile, 'utf-8')
    const parsed = JSON.parse(raw) as {
      executionId?: unknown
      resultId?: unknown
    }

    if (
      typeof parsed.executionId !== 'string' ||
      typeof parsed.resultId !== 'string'
    ) {
      throw new Error('Detached execution worker wrote invalid startup metadata')
    }

    return {
      executionId: parsed.executionId,
      resultId: parsed.resultId,
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

async function createRuntimeFromArgs(
  createRuntime: RunbookCliRuntimeFactory,
  args: ParsedArgs,
): Promise<RunbookCliRuntime> {
  return createRuntime({
    userDataPath: getFlag(args, 'user-data-dir'),
  })
}

async function runExecuteWorkerCommand(
  createRuntime: RunbookCliRuntimeFactory,
  args: ParsedArgs,
): Promise<void> {
  const runtime = await createRuntimeFromArgs(createRuntime, args)
  try {
    const execution = await runtime.executeRunbook({
      runbookId: requiredFlag(args, 'runbook-id'),
      parameterValues: parseParameterValues(args),
    })

    const startupFile = getFlag(args, 'startup-file')
    if (startupFile !== undefined && startupFile !== '') {
      await writeFile(
        startupFile,
        JSON.stringify({
          executionId: execution.executionId,
          resultId: execution.resultId,
        }),
        'utf-8',
      )
    } else if (typeof process.send === 'function') {
      process.send({
        type: 'execution_started',
        executionId: execution.executionId,
        resultId: execution.resultId,
      })
    }

    await runtime.waitForExecution(execution.executionId)
  } finally {
    await runtime.destroy()
  }
}

async function runExecuteCommand(
  createRuntime: RunbookCliRuntimeFactory,
  args: ParsedArgs,
  asJson: boolean,
): Promise<void> {
  const execution = await startDetachedExecution(args)
  if (!parseBooleanFlag(args, 'wait')) {
    printOutput(execution, asJson)
    return
  }

  const runtime = await createRuntimeFromArgs(createRuntime, args)
  try {
    const finalExecution = await runtime.waitForExecution(
      execution.executionId,
      { timeoutMs: parseIntegerFlag(args, 'timeout-ms') },
    )
    printOutput({
      executionId: execution.executionId,
      resultId: execution.resultId,
      timedOut: getExecutionStatus(finalExecution) === 'running',
      execution: finalExecution,
    }, asJson)
  } finally {
    await runtime.destroy()
  }
}

async function handleListCommand({ runtime, asJson }: RunbooksCommandContext): Promise<void> {
  const runbooks = await runtime.listRunbooks()
  printOutput(runbooks, asJson)
}

async function handleGetExecutionCommand({
  runtime,
  args,
  asJson,
}: RunbooksCommandContext): Promise<void> {
  const execution = await runtime.getExecution(
    requiredFlag(args, 'execution-id'),
  )
  printOutput(execution, asJson)
}

async function handleCancelCommand({
  runtime,
  args,
  asJson,
}: RunbooksCommandContext): Promise<void> {
  const executionId = requiredFlag(args, 'execution-id')
  await runtime.cancelExecution(executionId)
  const execution = await runtime.getExecution(executionId)
  printOutput({
    executionId,
    status: getExecutionStatus(execution) ?? 'unknown',
    execution,
  }, asJson)
}

async function handleDeleteCommand({
  runtime,
  args,
  asJson,
}: RunbooksCommandContext): Promise<void> {
  const result = await runtime.deleteRunbook(requiredFlag(args, 'runbook-id'))
  printOutput(result, asJson)
}

async function handleExportCommand({
  runtime,
  args,
  asJson,
}: RunbooksCommandContext): Promise<void> {
  const runbookIds = getFlagValues(args, 'runbook-id')
  if (runbookIds.length === 0) {
    throw new Error('At least one --runbook-id is required for export')
  }

  const includeGlobals = parseBooleanFlag(args, 'include-globals')
  const outputPath = getFlag(args, 'output')
  if (outputPath !== undefined && outputPath !== '') {
    const result = await runtime.exportRunbooksToFile(
      path.resolve(outputPath),
      runbookIds,
      includeGlobals,
    )
    printOutput(result, asJson)
    return
  }

  const artifact = await runtime.exportRunbooks(runbookIds, includeGlobals)
  printOutput(artifact, true)
}

function parseConflictPolicy(args: ParsedArgs): RunbookImportConflictPolicy | undefined {
  const value = getFlag(args, 'conflict-policy')
  if (value === undefined || value === '') {
    return undefined
  }

  switch (value) {
    case 'duplicate':
    case 'skip':
    case 'overwrite':
      return value
    default:
      throw new Error(`Unsupported conflict policy "${value}"`)
  }
}

async function handleImportCommand({
  runtime,
  args,
  asJson,
}: RunbooksCommandContext): Promise<void> {
  const filePath = path.resolve(requiredFlag(args, 'file'))
  const summary = await runtime.importRunbooksFromFile(filePath, {
    conflictPolicy: parseConflictPolicy(args),
    preserveIds: parseBooleanFlag(args, 'preserve-ids'),
    includeGlobals: parseBooleanFlag(args, 'include-globals'),
    dryRun: parseBooleanFlag(args, 'dry-run'),
  })
  printOutput(summary, asJson)
}

function resolveConfiguredPluginDirectory(args: ParsedArgs): string | undefined {
  const explicitPluginDirectory = getFlag(args, 'plugin-dir')
  if (
    explicitPluginDirectory !== undefined &&
    explicitPluginDirectory !== '' &&
    explicitPluginDirectory !== 'true'
  ) {
    return path.resolve(explicitPluginDirectory)
  }

  const userDataDirectory = getFlag(args, 'user-data-dir')
  if (
    userDataDirectory !== undefined &&
    userDataDirectory !== '' &&
    userDataDirectory !== 'true'
  ) {
    return path.join(path.resolve(userDataDirectory), 'plugins')
  }

  return undefined
}

function resolveConfiguredUserDataDirectory(args: ParsedArgs): string | undefined {
  const userDataDirectory = getFlag(args, 'user-data-dir')
  if (
    userDataDirectory !== undefined &&
    userDataDirectory !== '' &&
    userDataDirectory !== 'true'
  ) {
    return path.resolve(userDataDirectory)
  }

  return undefined
}

function resolveUserPluginDirectory(args: ParsedArgs): string {
  const configuredPluginDirectory = resolveConfiguredPluginDirectory(args)
  if (configuredPluginDirectory !== undefined) {
    return configuredPluginDirectory
  }

  const userDataDirectory = resolveConfiguredUserDataDirectory(args)
  return path.join(userDataDirectory ?? getRuntimeUserDataPath(), 'plugins')
}

function createPluginRuntime(args: ParsedArgs) {
  const installRoot = resolveUserPluginDirectory(args)
  const userDataDirectory = resolveConfiguredUserDataDirectory(args)
  const authStore = new LocalPluginCredentialsStore(userDataDirectory)
  const localPluginDirectories = resolveDesktopPluginDirectories([installRoot])

  return {
    runtime: createDesktopNodePluginRuntimeService(localPluginDirectories, authStore),
    authStore,
    installRoot,
  }
}

function normalizeCliStoredAuthValue(
  field: DesktopPluginFieldDefinition,
  value: unknown,
): DesktopPluginStoredAuthValue | undefined {
  if (value === undefined) {
    return undefined
  }

  switch (field.type) {
    case 'boolean':
      if (typeof value === 'boolean') {
        return value
      }
      if (value === 'true') {
        return true
      }
      if (value === 'false') {
        return false
      }
      throw new Error(`Auth field "${field.key}" must be a boolean`)
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const numeric = Number(value)
        if (Number.isFinite(numeric)) {
          return numeric
        }
      }
      throw new Error(`Auth field "${field.key}" must be a number`)
    case 'string_array':
      if (Array.isArray(value)) {
        return value
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      }
      if (typeof value === 'string') {
        return value
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      }
      throw new Error(`Auth field "${field.key}" must be a string array`)
    case 'json':
      return JSON.parse(JSON.stringify(value)) as DesktopPluginStoredAuthValue
    case 'string':
    default:
      if (typeof value !== 'string') {
        throw new Error(`Auth field "${field.key}" must be a string`)
      }
      if (field.enumValues !== undefined && !field.enumValues.includes(value)) {
        throw new Error(
          `Auth field "${field.key}" must be one of: ${field.enumValues.join(', ')}`,
        )
      }
      return value
  }
}

function normalizeCliStoredAuth(
  plugin: DesktopPluginDescriptor,
  rawValues: Record<string, unknown>,
): DesktopPluginStoredAuthRecord {
  const normalized: DesktopPluginStoredAuthRecord = {}
  const fieldsByKey = new Map(plugin.auth.fields.map((field) => [field.key, field]))

  for (const [key, value] of Object.entries(rawValues)) {
    const field = fieldsByKey.get(key)
    if (field === undefined) {
      continue
    }

    const normalizedValue = normalizeCliStoredAuthValue(field, value)
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue
    }
  }

  return normalized
}

function redactStoredAuth(
  plugin: DesktopPluginDescriptor,
  values: DesktopPluginStoredAuthRecord,
  revealSecrets: boolean,
): DesktopPluginStoredAuthRecord {
  if (revealSecrets) {
    return values
  }

  const secretKeys = new Set(
    plugin.auth.fields
      .filter((field) => field.secret === true)
      .map((field) => field.key),
  )
  const redacted: DesktopPluginStoredAuthRecord = {}
  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) {
      redacted[key] = '********'
      continue
    }

    redacted[key] = value
  }

  return redacted
}

async function readBinarySource(source: string): Promise<Buffer> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`Failed to download plugin artifact (${String(response.status)} ${response.statusText})`)
    }

    return Buffer.from(await response.arrayBuffer())
  }

  if (source.startsWith('file://')) {
    return readFile(fileURLToPath(source))
  }

  return readFile(path.resolve(source))
}

async function readTextSource(source: string): Promise<string> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(`Failed to download plugin index (${String(response.status)} ${response.statusText})`)
    }

    return response.text()
  }

  if (source.startsWith('file://')) {
    return readFile(fileURLToPath(source), 'utf-8')
  }

  return readFile(path.resolve(source), 'utf-8')
}

function resolvePluginIndexUrl(args: ParsedArgs): string {
  const configured = getFlag(args, 'index-url') ?? process.env.BITSENTRY_PLUGIN_INDEX_URL
  if (configured !== undefined && configured.trim().length > 0 && configured !== 'true') {
    const indexUrl = configured.trim()
    assertFirstPartyRemoteUrl(indexUrl, 'indexes')
    return indexUrl
  }

  return DEFAULT_PLUGIN_INDEX_URL
}

function isRemoteUrl(source: string): boolean {
  return source.startsWith('http://') || source.startsWith('https://')
}

function assertFirstPartyRemoteUrl(source: string, label: string): void {
  if (!isRemoteUrl(source)) {
    return
  }

  const parsed = new URL(source)
  if (parsed.origin !== DEFAULT_PLUGIN_INDEX_ORIGIN) {
    throw new Error(
      `Remote plugin ${label} must use the first-party origin ${DEFAULT_PLUGIN_INDEX_ORIGIN}`,
    )
  }
}

function readPluginName(args: ParsedArgs): string {
  const name = args.positionals.at(2)
  if (name === undefined || name.trim().length === 0) {
    throw new Error('Plugin name is required')
  }

  return name.trim()
}

function sourceRelativeUrl(source: string, relativeUrl: string): string {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    return new URL(relativeUrl, source).toString()
  }

  if (source.startsWith('file://')) {
    return path.resolve(path.dirname(fileURLToPath(source)), relativeUrl)
  }

  return path.resolve(path.dirname(path.resolve(source)), relativeUrl)
}

function readIndexEntryRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function readIndexEntryName(
  fallbackName: string,
  record: Record<string, unknown>,
): string {
  const entryName = record.name
  if (typeof entryName === 'string' && entryName.trim().length > 0) {
    return entryName.trim()
  }

  const entryId = record.id
  if (typeof entryId === 'string' && entryId.trim().length > 0) {
    return entryId.trim()
  }

  return fallbackName
}

function readIndexEntryDescription(
  record: Record<string, unknown>,
): string | undefined {
  const description = record.description
  if (typeof description !== 'string') {
    return undefined
  }

  const normalized = description.trim()
  if (normalized.length === 0) {
    return undefined
  }

  return normalized
}

function pluginIndexEntryListItem(entry: PluginIndexEntry | null): PluginIndexEntry[] {
  if (entry === null) {
    return []
  }

  return [entry]
}

function parsePluginIndexEntry(name: string, value: unknown): PluginIndexEntry | null {
  const record = readIndexEntryRecord(value)
  if ('version' in record || 'versions' in record) {
    throw new Error('Plugin index must not include version fields in v1')
  }

  const artifactUrl = record.artifactUrl ?? record.artifact_url ?? record.url
  if (typeof artifactUrl !== 'string' || artifactUrl.trim().length === 0) {
    return null
  }

  return {
    name: readIndexEntryName(name, record),
    artifactUrl: artifactUrl.trim(),
    description: readIndexEntryDescription(record),
  }
}

function parsePluginIndex(raw: string): PluginIndexEntry[] {
  const parsed = parseYaml(raw) as unknown
  const root = readIndexEntryRecord(parsed)
  if ('version' in root || 'versions' in root) {
    throw new Error('Plugin index must not include version fields in v1')
  }

  const plugins = root.plugins
  if (Array.isArray(plugins)) {
    return plugins.flatMap((entry) => {
      const parsedEntry = parsePluginIndexEntry('', entry)
      return pluginIndexEntryListItem(parsedEntry)
    })
  }

  const pluginRecord = readIndexEntryRecord(plugins)
  return Object.entries(pluginRecord).flatMap(([name, entry]) => {
    const parsedEntry = parsePluginIndexEntry(name, entry)
    return pluginIndexEntryListItem(parsedEntry)
  })
}

async function readPluginIndex(args: ParsedArgs): Promise<{
  entries: PluginIndexEntry[]
  indexUrl: string
}> {
  const indexUrl = resolvePluginIndexUrl(args)
  const raw = await readTextSource(indexUrl)
  const entries = parsePluginIndex(raw)
  for (const entry of entries) {
    assertFirstPartyRemoteUrl(sourceRelativeUrl(indexUrl, entry.artifactUrl), 'artifacts')
  }

  return {
    entries,
    indexUrl,
  }
}

async function resolvePluginIndexEntry(args: ParsedArgs, name: string): Promise<{
  entry: PluginIndexEntry
  indexUrl: string
}> {
  const index = await readPluginIndex(args)
  const entry = index.entries.find((candidate) => candidate.name === name)
  if (entry === undefined) {
    throw new Error(`Plugin "${name}" was not found in the first-party index`)
  }

  return {
    entry,
    indexUrl: index.indexUrl,
  }
}

function handlePluginListCommand({ args, asJson }: PluginCommandContext): void {
  const { runtime } = createPluginRuntime(args)
  printOutput(runtime.listPlugins(), asJson)
}

async function handlePluginInfoCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const { runtime } = createPluginRuntime(args)
  const pluginName = readPluginName(args)
  const plugin = runtime.getPlugin(pluginName)
  if (plugin !== null) {
    printOutput(plugin, asJson)
    return
  }

  const { entry, indexUrl } = await resolvePluginIndexEntry(args, pluginName)
  printOutput({
    ...entry,
    indexUrl,
    installed: false,
  }, asJson)
}

async function installPluginFromIndex(
  args: ParsedArgs,
  pluginName: string,
): Promise<unknown> {
  if (hasFlag(args, 'version')) {
    throw new Error('Plugin versioning is not supported in v1')
  }

  const { runtime, installRoot } = createPluginRuntime(args)
  const { entry, indexUrl } = await resolvePluginIndexEntry(args, pluginName)
  const artifactUrl = sourceRelativeUrl(indexUrl, entry.artifactUrl)
  const artifact = await readBinarySource(artifactUrl)
  const result = await runtime.installFromArtifact({
    artifactBase64: artifact.toString('base64'),
    installRoot,
  })

  return {
    ...result,
    name: entry.name,
    indexUrl,
    artifactUrl,
  }
}

async function handlePluginInstallCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  printOutput(await installPluginFromIndex(args, readPluginName(args)), asJson)
}

async function handlePluginUpdateCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  printOutput(await installPluginFromIndex(args, readPluginName(args)), asJson)
}

async function handlePluginRemoveCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const pluginId = readPluginName(args)
  const { authStore, installRoot } = createPluginRuntime(args)
  await rm(path.join(installRoot, pluginId), { recursive: true, force: true })
  await authStore.clear(pluginId)
  printOutput({
    pluginId,
    removed: true,
  }, asJson)
}

async function handlePluginConfigureCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const { runtime, authStore } = createPluginRuntime(args)
  const pluginId = readPluginName(args)
  const plugin = runtime.getPlugin(pluginId)
  if (plugin === null) {
    throw new Error(`Unknown plugin "${pluginId}"`)
  }

  const configured = normalizeCliStoredAuth(plugin, parseJsonObjectFlag(args, 'auth-json'))
  const stored = await authStore.set(pluginId, configured)
  printOutput({
    pluginId,
    updatedKeys: Object.keys(stored),
  }, asJson)
}

async function handlePluginShowConfigCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const { runtime, authStore } = createPluginRuntime(args)
  const pluginId = readPluginName(args)
  const plugin = runtime.getPlugin(pluginId)
  if (plugin === null) {
    throw new Error(`Unknown plugin "${pluginId}"`)
  }

  const stored = await authStore.get(pluginId)
  printOutput({
    pluginId,
    values: redactStoredAuth(plugin, stored, parseBooleanFlag(args, 'reveal-secrets')),
  }, asJson)
}

async function handlePluginClearConfigCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const { authStore } = createPluginRuntime(args)
  const pluginId = readPluginName(args)
  await authStore.clear(pluginId)
  printOutput({
    pluginId,
    cleared: true,
  }, asJson)
}

async function handlePluginExecuteCommand({ args, asJson }: PluginCommandContext): Promise<void> {
  const { runtime } = createPluginRuntime(args)
  const result = await runtime.executeAction({
    pluginId: requiredFlag(args, 'plugin-id'),
    actionId: requiredFlag(args, 'action-id'),
    auth: parseJsonObjectFlag(args, 'auth-json'),
    input: parseJsonObjectFlag(args, 'input-json'),
  })

  printOutput(result, asJson)
}

const runbooksCommandHandlers = new Map<string, RunbooksCommandHandler>([
  ['list', handleListCommand],
  ['get-execution', handleGetExecutionCommand],
  ['cancel', handleCancelCommand],
  ['delete', handleDeleteCommand],
  ['export', handleExportCommand],
  ['import', handleImportCommand],
])

const pluginCommandHandlers = new Map<string, PluginCommandHandler>([
  ['list', handlePluginListCommand],
  ['info', handlePluginInfoCommand],
  ['install', handlePluginInstallCommand],
  ['update', handlePluginUpdateCommand],
  ['remove', handlePluginRemoveCommand],
  ['configure', handlePluginConfigureCommand],
  ['show-config', handlePluginShowConfigCommand],
  ['clear-config', handlePluginClearConfigCommand],
  ['execute', handlePluginExecuteCommand],
])

function resolveCliCommand(args: ParsedArgs): ResolvedCliCommand | null {
  const scope = args.positionals.at(0)
  const command = args.positionals.at(1)

  if (scope === undefined || scope === '' || scope === 'help' || scope === '--help') {
    return null
  }

  if (scope !== 'runbooks' && scope !== 'plugin') {
    throw new Error(`Unsupported scope "${scope}". Available scopes: runbooks, plugin.`)
  }

  if (command === undefined || command === '') {
    return null
  }

  return { scope, command }
}

export async function runRunbooksCli(
  createRuntime: RunbookCliRuntimeFactory,
  argv = process.argv,
): Promise<void> {
  const args = parseArgv(argv.slice(2))
  const resolvedCommand = resolveCliCommand(args)
  if (resolvedCommand === null) {
    printHelp()
    return
  }

  const asJson = parseBooleanFlag(args, 'json')
  if (resolvedCommand.scope === 'plugin') {
    const handler = pluginCommandHandlers.get(resolvedCommand.command)
    if (handler === undefined) {
      throw new Error(`Unsupported plugin command "${resolvedCommand.command}"`)
    }

    await handler({ args, asJson })
    return
  }

  const { command } = resolvedCommand
  if (command === 'execute-worker') {
    await runExecuteWorkerCommand(createRuntime, args)
    return
  }

  if (command === 'execute') {
    await runExecuteCommand(createRuntime, args, asJson)
    return
  }

  const handler = runbooksCommandHandlers.get(command)
  if (handler === undefined) {
    throw new Error(`Unsupported runbooks command "${command}"`)
  }

  const runtime = await createRuntimeFromArgs(createRuntime, args)
  try {
    await handler({ runtime, args, asJson })
  } finally {
    await runtime.destroy()
  }
}
