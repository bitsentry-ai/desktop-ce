import { access } from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'

interface RunPackagedCliSmokeOptions {
  desktopDir: string
  candidateWrapperPaths: string[]
  defaultTestScriptRelativePath?: string
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

function readFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index === -1) {
    return null
  }

  if (index + 1 >= process.argv.length) {
    return null
  }

  const value = process.argv[index + 1]
  if (value === '') {
    return null
  }

  return path.resolve(value)
}

async function resolvePackagedCliPath(
  desktopDir: string,
  candidateWrapperPaths: string[],
): Promise<string> {
  for (const candidate of candidateWrapperPaths) {
    const absoluteCandidate = path.resolve(desktopDir, candidate)
    if (await pathExists(absoluteCandidate)) {
      return absoluteCandidate
    }
  }

  throw new Error(
    `Unable to locate the packaged BitSentry CLI wrapper for platform ${process.platform}. ` +
      'Pass --wrapper-path explicitly if the artifact lives elsewhere.',
  )
}

async function waitForExitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('close', (code) => {
      resolve(code)
    })
  })
}

export async function runPackagedCliSmoke({
  desktopDir,
  candidateWrapperPaths,
  defaultTestScriptRelativePath = path.join('scripts', 'dist', 'cli-smoke-test.js'),
}: RunPackagedCliSmokeOptions): Promise<void> {
  const explicit = readFlagValue('--wrapper-path')
  let packagedCliPath = explicit
  if (packagedCliPath === null) {
    packagedCliPath = await resolvePackagedCliPath(desktopDir, candidateWrapperPaths)
  }

  let testScriptPath = readFlagValue('--test-script')
  if (testScriptPath === null) {
    testScriptPath = path.resolve(desktopDir, defaultTestScriptRelativePath)
  }

  const child = spawn(process.execPath, [testScriptPath], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      BITSENTRY_CLI_USE_WRAPPER: '1',
      BITSENTRY_CLI_BINARY: packagedCliPath,
    },
  })

  const code = await waitForExitCode(child)
  if (code !== 0) {
    throw new Error(
      `Packaged CLI smoke failed for ${packagedCliPath} with exit code ${String(code)}`,
    )
  }
}
