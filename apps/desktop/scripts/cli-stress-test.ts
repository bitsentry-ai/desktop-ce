import path from 'path'

const { runCliStressTest } = require(
  path.resolve(
    __dirname,
    '../../../../packages/desktop-cli/dist/testing/cli-stress-test.js',
  ),
) as typeof import('../../../packages/desktop-cli/dist/testing/cli-stress-test.js', {
  with: { 'resolution-mode': 'import' }
})

void runCliStressTest(path.resolve(__dirname, '../..')).catch((error: unknown) => {
  let message = String(error)
  if (error instanceof Error) {
    message = error.stack ?? error.message
  }

  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
