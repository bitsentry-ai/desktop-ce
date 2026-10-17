import path from 'path'

type AfterPackModule = {
  runAfterPack: (context: unknown, desktopDir: string) => Promise<void>
}

function getFirstArgument(args: string[]): string | undefined {
  if (args.length === 0) {
    return undefined
  }

  return args[0]
}

async function main(): Promise<void> {
  const { runAfterPack } = require(
    path.resolve(
      __dirname,
      '../../../../packages/desktop-cli/dist/packaging/after-pack.js',
    ),
  ) as AfterPackModule
  const rawContext = getFirstArgument(process.argv.slice(2))
  if (rawContext === undefined || rawContext.length === 0) {
    throw new Error('Missing afterPack context payload path.')
  }

  const context: unknown = JSON.parse(rawContext)
  await runAfterPack(context, path.resolve(__dirname, '../..'))
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }

  return String(error)
}

void main().catch((error: unknown) => {
  const message = getErrorMessage(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
