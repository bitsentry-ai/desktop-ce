import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(scriptDir, '..')
const packageJsonPath = path.join(scriptDir, '..', 'package.json')
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
const require = createRequire(import.meta.url)

function run(command, args) {
  const pnpmExecPath = process.env.npm_execpath
  const [spawnCommand, spawnArgs] =
    command === 'pnpm' && pnpmExecPath
      ? [process.execPath, [pnpmExecPath, ...args]]
      : process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
        : [command, args]
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd: path.join(scriptDir, '..'),
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function ensureElectronBinary() {
  const electronPackageJson = require.resolve('electron/package.json', {
    paths: [appRoot],
  })
  const electronPackageRoot = path.dirname(electronPackageJson)
  const electronPathFile = path.join(electronPackageRoot, 'path.txt')
  if (existsSync(electronPathFile)) {
    return
  }

  run(process.execPath, [path.join(electronPackageRoot, 'install.js')])
}

function extractArgValue(flagName) {
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(`${flagName}=`))
  if (inline) {
    return inline.slice(flagName.length + 1)
  }

  const index = process.argv.indexOf(flagName)
  if (index >= 0) {
    return process.argv[index + 1]
  }

  return undefined
}

ensureElectronBinary()

if (process.platform === 'win32') {
  const electronVersion = String(packageJson.devDependencies?.electron ?? '').replace(
    /^[^0-9]*/,
    '',
  )
  const arch = extractArgValue('--arch')
  const rebuildArgs = [
    'exec',
    'electron-rebuild',
    '--version',
    electronVersion,
    '--module-dir',
    '.',
    '--only',
    'better-sqlite3',
    '--types',
    'prod,optional',
    '--sequential',
  ]

  if (arch) {
    rebuildArgs.push('--arch', arch)
  }

  run('pnpm', rebuildArgs)
} else {
  run('pnpm', ['exec', 'electron-builder', 'install-app-deps', ...process.argv.slice(2)])
}
