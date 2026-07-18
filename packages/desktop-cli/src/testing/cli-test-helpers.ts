import { readFile, rm, writeFile } from 'fs/promises'
import { spawn } from 'child_process'
import { createRequire } from 'module'
import path from 'path'
import YAML from 'yaml'

export type CliJson = Record<string, unknown>
export type CliValue = CliJson | Array<unknown>

const RETRIABLE_CLEANUP_ERRORS = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])

export interface ExportedRunbookActionParameter {
  key: string
  label?: string
  description?: string
  defaultValue?: string
  required?: boolean
  secure?: boolean
}

export interface ExportedRunbookAction {
  type: 'shell'
  title: string
  command: string
  parameters?: ExportedRunbookActionParameter[]
}

export interface ExportedRunbookDefinition {
  title: string
  description?: string
  actions: ExportedRunbookAction[]
}

type CliInvocation = {
  binary: string
  prefixArgs: string[]
  env: NodeJS.ProcessEnv
  shell?: boolean
}

async function waitForExitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('close', (code) => {
      resolve(code)
    })
  })
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function getErrorCode(error: unknown): string {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return ''
  }

  const { code } = error
  if (typeof code !== 'string') {
    return ''
  }

  return code
}

export function createCliTestContext(desktopDir: string) {
  const cliEntry = path.join(desktopDir, 'out', 'cli-bundle', 'cli.js')
  const desktopRequire = createRequire(path.join(desktopDir, 'package.json'))
  const waitPollMs = 250

  function resolveElectronBinary(): string {
    try {
      const electronModulePath = desktopRequire.resolve('electron', {
        paths: [desktopDir],
      })
      const electronBinary: unknown = desktopRequire(electronModulePath)
      if (typeof electronBinary !== 'string') {
        throw new Error(`Electron resolved to a non-string value from ${electronModulePath}`)
      }

      return electronBinary
    } catch (error) {
      throw new Error(
        `Unable to resolve the Electron binary from ${desktopDir}: ${getErrorMessage(error)}`,
      )
    }
  }

  function getCliInvocation(): CliInvocation {
    const configuredBinary = process.env.BITSENTRY_CLI_BINARY?.trim() ?? ''
    if (process.env.BITSENTRY_CLI_USE_WRAPPER === '1') {
      if (configuredBinary === '') {
        throw new Error('BITSENTRY_CLI_BINARY is required when BITSENTRY_CLI_USE_WRAPPER=1')
      }

      const usesWindowsShell =
        process.platform === 'win32' &&
        /\.(cmd|bat)$/i.test(configuredBinary)

      return {
        binary: configuredBinary,
        prefixArgs: [],
        shell: usesWindowsShell,
        env: {
          ...process.env,
        },
      }
    }

    let binary = configuredBinary
    if (binary === '') {
      binary = resolveElectronBinary()
    }

    return {
      binary,
      prefixArgs: [cliEntry],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    }
  }

  const cliInvocation = getCliInvocation()

  function escapeShellDoubleQuoted(value: string): string {
    return value.replace(/(["\\$`])/g, '\\$1')
  }

  function quoteShellPath(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`
  }

  return {
    async assertCliBundleExists(): Promise<void> {
      if (cliInvocation.prefixArgs.length > 0) {
        await readFile(cliEntry, 'utf-8')
      }
    },

    async createNodeCommand(
      tempDir: string,
      scriptName: string,
      source: string,
      args: string[] = [],
    ): Promise<string> {
      const scriptPath = path.join(tempDir, `${scriptName}.js`)
      await writeFile(scriptPath, source, 'utf-8')
      const serializedArgs = args
        .map((value) => `"${escapeShellDoubleQuoted(value)}"`)
        .join(' ')
      let command = `${quoteShellPath(process.execPath)} ${quoteShellPath(scriptPath)}`
      if (serializedArgs !== '') {
        command = `${command} ${serializedArgs}`
      }

      return command
    },

    async runCliJson(
      userDataDir: string,
      args: string[],
    ): Promise<CliValue> {
      const child = spawn(cliInvocation.binary, [
        ...cliInvocation.prefixArgs,
        ...args,
        '--user-data-dir',
        userDataDir,
        '--json',
      ], {
        cwd: desktopDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliInvocation.env,
        shell: cliInvocation.shell ?? false,
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

      const code = await waitForExitCode(child)
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim()

      if (code !== 0) {
        let failureDetail = stderr
        if (failureDetail === '') {
          failureDetail = stdout
        }
        if (failureDetail === '') {
          failureDetail = `exit ${String(code)}`
        }

        throw new Error(`CLI command failed (${args.join(' ')}): ${failureDetail}`)
      }

      if (stdout === '') {
        return {}
      }

      return JSON.parse(stdout) as CliValue
    },

    async writeRunbookArtifact(
      tempDir: string,
      artifactName: string,
      runbooks: ExportedRunbookDefinition[],
    ): Promise<string> {
      const filePath = path.join(tempDir, `${artifactName}.yaml`)
      const artifact = {
        format: 'bitsentry.runbooks.export',
        version: 1,
        exportedAt: '2026-06-17T00:00:00.000Z',
        exportedBy: {
          product: 'superterminal',
          runtime: 'desktop',
        },
        runbooks,
      }

      await writeFile(filePath, YAML.stringify(artifact), 'utf-8')
      return filePath
    },

    async importRunbooksFromArtifact(
      userDataDir: string,
      filePath: string,
    ): Promise<Array<{ title: string; runbookId: string }>> {
      const imported = await this.runCliJson(userDataDir, ['runbooks', 'import', '--file', filePath])
      let importedPayload: Record<string, unknown> = {}
      if (!Array.isArray(imported)) {
        importedPayload = imported
      }

      let importedResults: Array<Record<string, unknown>> = []
      if (Array.isArray(importedPayload.results)) {
        importedResults = importedPayload.results.filter(
          (result): result is Record<string, unknown> =>
            result !== null &&
            typeof result === 'object' &&
            !Array.isArray(result),
        )
      }

      const normalized = importedResults.flatMap((result) => {
        if (
          typeof result.title !== 'string' ||
          typeof result.runbookId !== 'string' ||
          result.status !== 'imported' ||
          result.title === '' ||
          result.runbookId === ''
        ) {
          return []
        }

        return [{ title: result.title, runbookId: result.runbookId }]
      })

      if (normalized.length === 0) {
        throw new Error(`Runbook import did not return any imported ids for ${filePath}`)
      }

      return normalized
    },

    async importSingleRunbook(
      userDataDir: string,
      tempDir: string,
      artifactName: string,
      runbook: ExportedRunbookDefinition,
    ): Promise<string> {
      const filePath = await this.writeRunbookArtifact(tempDir, artifactName, [runbook])
      const imported = await this.importRunbooksFromArtifact(userDataDir, filePath)
      return imported[0].runbookId
    },

    async waitForExecution(
      userDataDir: string,
      executionId: string,
      timeoutMs: number,
    ): Promise<CliJson> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const execution = await this.runCliJson(userDataDir, [
          'runbooks',
          'get-execution',
          '--execution-id',
          executionId,
        ])
        if (Array.isArray(execution)) {
          throw new Error(`Execution lookup did not return an object for ${executionId}`)
        }

        if (execution.status !== 'running') {
          return execution
        }

        await this.sleep(waitPollMs)
      }

      throw new Error(`Execution ${executionId} did not finish within ${String(timeoutMs)}ms`)
    },

    async sleep(ms: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms))
    },
  }
}

export async function removeTempDirWithRetry(
  dirPath: string,
  options: {
    attempts?: number
    delayMs?: number
  } = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 8)
  const delayMs = Math.max(50, options.delayMs ?? 250)

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(dirPath, { recursive: true, force: true, maxRetries: 0 })
      return
    } catch (error) {
      const code = getErrorCode(error)
      const shouldRetry = RETRIABLE_CLEANUP_ERRORS.has(code) && attempt < attempts

      if (!shouldRetry) {
        throw error
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
    }
  }
}
