import path from 'path'

const desktopDir = path.resolve(__dirname, '../..')
type PackagedCliSmokeModule = {
  runPackagedCliSmoke: (options: {
    desktopDir: string
    candidateWrapperPaths: string[]
  }) => Promise<void>
}

const { runPackagedCliSmoke } = require(
  path.resolve(
    __dirname,
    '../../../../packages/desktop-cli/dist/testing/packaged-cli-smoke.js',
  ),
) as PackagedCliSmokeModule

function getCandidateWrapperPaths(): string[] {
  if (process.platform === 'darwin') {
    return [
      path.join('release', 'build', 'mac-arm64', 'BitSentry-Desktop.app', 'Contents', 'Resources', 'bin', 'bitsentry'),
      path.join('release', 'build', 'mac', 'BitSentry-Desktop.app', 'Contents', 'Resources', 'bin', 'bitsentry'),
    ]
  }

  if (process.platform === 'win32') {
    return [
      path.join('release', 'build', 'win-unpacked', 'bitsentry.cmd'),
    ]
  }

  return [
    path.join('release', 'build', 'linux-unpacked', 'bitsentry'),
    path.join('release', 'build', 'linux-arm64-unpacked', 'bitsentry'),
    path.join('release', 'build', 'linux-x64-unpacked', 'bitsentry'),
  ]
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }

  return String(error)
}

void runPackagedCliSmoke({
  desktopDir,
  candidateWrapperPaths: getCandidateWrapperPaths(),
}).catch((error: unknown) => {
  const message = getErrorMessage(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
