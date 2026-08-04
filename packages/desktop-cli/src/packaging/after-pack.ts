import { access, chmod, cp, mkdir, readdir, realpath, writeFile } from 'fs/promises'
import path from 'path'

export type ElectronPlatformName = 'darwin' | 'linux' | 'win32'
const CLI_WRAPPER_NODE_PATH_ENV = 'BITSENTRY_CLI_WRAPPER_NODE_PATH'

export interface AfterPackContextLike {
  appOutDir: string
  electronPlatformName: ElectronPlatformName
  packager?: {
    appInfo?: {
      productFilename?: string
      productName?: string
    }
  }
}

function getProductNames(context: AfterPackContextLike): string[] {
  const productFilename = context.packager?.appInfo?.productFilename?.trim()
  const productName = context.packager?.appInfo?.productName?.trim()
  const appBundleName = getAppBundleName(context)

  const rawNames = [productFilename, productName, appBundleName]
    .filter((value): value is string => value !== undefined && value !== '')

  const normalized = new Set<string>()
  for (const rawName of rawNames) {
    normalized.add(rawName)
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    let start = 0
    let end = slug.length
    while (slug[start] === '-') start += 1
    while (end > start && slug[end - 1] === '-') end -= 1
    normalized.add(slug.slice(start, end))
  }

  return [...normalized].filter(Boolean)
}

function getAppBundleName(context: AfterPackContextLike): string {
  if (context.electronPlatformName === 'darwin') {
    return path.basename(context.appOutDir, '.app').trim()
  }

  return path.basename(context.appOutDir).trim()
}

function toPosixRelativePath(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).split(path.sep).join('/')
}

async function copyResolvedPackage(
  packageName: string,
  destinationNodeModulesDir: string,
  projectRoot: string,
): Promise<void> {
  const packageJsonPath = await resolvePackageJsonPath(packageName, projectRoot)
  const sourceDir = await realpath(path.dirname(packageJsonPath))
  const destinationDir = path.join(destinationNodeModulesDir, packageName)
  await mkdir(path.dirname(destinationDir), { recursive: true })
  await cp(sourceDir, destinationDir, { recursive: true, dereference: true })
}

async function resolvePackageJsonPath(
  packageName: string,
  projectRoot: string,
): Promise<string> {
  for (const resolutionRoot of [
    projectRoot,
    path.resolve(projectRoot, '../..'),
  ]) {
    try {
      return require.resolve(`${packageName}/package.json`, {
        paths: [resolutionRoot],
      })
    } catch {
      // Fall through to the pnpm store lookup below.
    }
  }

  const pnpmStoreDir = path.resolve(projectRoot, '../../node_modules/.pnpm')
  const entries = await readdir(pnpmStoreDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const candidate = path.join(
      pnpmStoreDir,
      entry.name,
      'node_modules',
      packageName,
      'package.json',
    )

    try {
      await access(candidate)
      return candidate
    } catch {
      // Keep scanning pnpm store entries until a match is found.
    }
  }

  throw new Error(`Unable to locate package.json for ${packageName}`)
}

async function ensureCliRuntimeDependencies(
  nativeNodeModulesDir: string,
  projectRoot: string,
): Promise<void> {
  await mkdir(nativeNodeModulesDir, { recursive: true })

  // Native packages are rebuilt into app.asar.unpacked by electron-builder, but
  // their tiny JS helper deps can remain only in the source workspace tree.
  // Copy them alongside the unpacked native modules so the packaged CLI can
  // resolve runtime requires like better-sqlite3 -> bindings -> file-uri-to-path.
  for (const packageName of ['bindings', 'file-uri-to-path', 'node-addon-api']) {
    await copyResolvedPackage(packageName, nativeNodeModulesDir, projectRoot)
  }
}

async function writeExecutableScript(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, 'utf-8')
  await chmod(filePath, 0o755)
}

async function resolveMacAppBundlePath(context: AfterPackContextLike): Promise<string> {
  if (context.appOutDir.endsWith('.app')) {
    return context.appOutDir
  }

  const entries = await readdir(context.appOutDir, { withFileTypes: true })
  const productNames = getProductNames(context)

  for (const productName of productNames) {
    const directMatch = entries.find(
      (entry) => entry.isDirectory() && entry.name === `${productName}.app`,
    )
    if (directMatch !== undefined) {
      return path.join(context.appOutDir, directMatch.name)
    }
  }

  const firstBundle = entries.find(
    (entry) => entry.isDirectory() && entry.name.endsWith('.app'),
  )
  if (firstBundle !== undefined) {
    return path.join(context.appOutDir, firstBundle.name)
  }

  throw new Error(`Unable to locate macOS app bundle in ${context.appOutDir}`)
}

async function createMacCliWrapper(
  context: AfterPackContextLike,
  projectRoot: string,
): Promise<void> {
  const appBundlePath = await resolveMacAppBundlePath(context)
  const appName = path.basename(appBundlePath, '.app')
  const resourcesDir = path.join(appBundlePath, 'Contents', 'Resources')
  const resourcesBinDir = path.join(resourcesDir, 'bin')
  const cliDir = path.join(resourcesDir, 'cli')
  const nativeNodeModulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  await cp(path.join(projectRoot, 'out', 'cli-bundle'), cliDir, { recursive: true })
  await ensureCliRuntimeDependencies(nativeNodeModulesDir, projectRoot)
  const cliEntry = path.join(cliDir, 'cli.js')
  const macBinary = path.join(appBundlePath, 'Contents', 'MacOS', appName)
  const relativeCliEntry = toPosixRelativePath(resourcesBinDir, cliEntry)
  const relativeAppBinary = toPosixRelativePath(resourcesBinDir, macBinary)
  const relativeNativeNodeModulesDir = toPosixRelativePath(
    resourcesBinDir,
    nativeNodeModulesDir,
  )

  await writeExecutableScript(
    path.join(resourcesBinDir, 'bitsentry'),
    `#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="\${BASH_SOURCE[0]}"
while [ -L "\${SOURCE_PATH}" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "\${SOURCE_PATH}")" && pwd)"
  LINK_TARGET="$(readlink "\${SOURCE_PATH}")"
  if [[ "\${LINK_TARGET}" = /* ]]; then
    SOURCE_PATH="\${LINK_TARGET}"
  else
    SOURCE_PATH="\${SOURCE_DIR}/\${LINK_TARGET}"
  fi
done
SCRIPT_DIR="$(cd -P "$(dirname "\${SOURCE_PATH}")" && pwd)"
APP_BIN="\${SCRIPT_DIR}/${relativeAppBinary}"
CLI_ENTRY="\${SCRIPT_DIR}/${relativeCliEntry}"
NATIVE_NODE_MODULES="\${SCRIPT_DIR}/${relativeNativeNodeModulesDir}"

export ELECTRON_RUN_AS_NODE=1
export NODE_PATH="\${NATIVE_NODE_MODULES}"
export ${CLI_WRAPPER_NODE_PATH_ENV}="\${NATIVE_NODE_MODULES}"
exec "\${APP_BIN}" "\${CLI_ENTRY}" "$@"
`,
  )
}

async function createLinuxCliWrapper(
  context: AfterPackContextLike,
  projectRoot: string,
): Promise<void> {
  const appDir = context.appOutDir
  const resourcesDir = path.join(appDir, 'resources')
  const cliDir = path.join(resourcesDir, 'cli')
  const nativeNodeModulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  await cp(path.join(projectRoot, 'out', 'cli-bundle'), cliDir, { recursive: true })
  await ensureCliRuntimeDependencies(nativeNodeModulesDir, projectRoot)
  const productNames = getProductNames(context)
  const candidates = [...productNames, 'AppRun']
    .map((name) => `"${name}"`)
    .join(' ')

  await writeExecutableScript(
    path.join(appDir, 'bitsentry'),
    `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
CLI_ENTRY="\${APP_DIR}/resources/cli/cli.js"
NATIVE_NODE_MODULES="\${APP_DIR}/resources/app.asar.unpacked/node_modules"

if [ ! -f "\${CLI_ENTRY}" ]; then
  echo "BitSentry CLI entrypoint not found: \${CLI_ENTRY}" >&2
  exit 1
fi

APP_BIN=""
for candidate in ${candidates}; do
  if [ -x "\${APP_DIR}/\${candidate}" ] && [ "\${candidate}" != "bitsentry" ]; then
    APP_BIN="\${APP_DIR}/\${candidate}"
    break
  fi
done

if [ -z "\${APP_BIN}" ]; then
  for fallback in "\${APP_DIR}"/*; do
    if [ ! -f "\${fallback}" ] || [ ! -x "\${fallback}" ]; then
      continue
    fi

    fallback_name="$(basename "\${fallback}")"
    case "\${fallback_name}" in
      bitsentry|chrome-sandbox|chrome_crashpad_handler)
        continue
        ;;
    esac

    APP_BIN="\${fallback}"
    break
  done
fi

if [ -z "\${APP_BIN}" ]; then
  echo "Unable to locate the packaged BitSentry Desktop executable in \${APP_DIR}" >&2
  exit 1
fi

export ELECTRON_RUN_AS_NODE=1
export NODE_PATH="\${NATIVE_NODE_MODULES}"
export ${CLI_WRAPPER_NODE_PATH_ENV}="\${NATIVE_NODE_MODULES}"
exec "\${APP_BIN}" "\${CLI_ENTRY}" "$@"
`,
  )
}

async function createWindowsCliWrapper(
  context: AfterPackContextLike,
  projectRoot: string,
): Promise<void> {
  const appDir = context.appOutDir
  const resourcesDir = path.join(appDir, 'resources')
  const cliDir = path.join(resourcesDir, 'cli')
  const nativeNodeModulesDir = path.join(resourcesDir, 'app.asar.unpacked', 'node_modules')
  await cp(path.join(projectRoot, 'out', 'cli-bundle'), cliDir, { recursive: true })
  await ensureCliRuntimeDependencies(nativeNodeModulesDir, projectRoot)
  const productNames = getProductNames(context)
  const candidateAssignments = productNames
    .map((name) => {
      let executableName = name
      if (!name.toLowerCase().endsWith('.exe')) {
        executableName = `${name}.exe`
      }

      return `if not defined APP_BIN if exist "%SCRIPT_DIR%${executableName}" set "APP_BIN=%SCRIPT_DIR%${executableName}"`
    })
    .join('\r\n')

  await writeFile(
    path.join(appDir, 'bitsentry.cmd'),
    `@echo off
setlocal enableextensions

set "SCRIPT_DIR=%~dp0"
set "CLI_ENTRY=%SCRIPT_DIR%resources\\cli\\cli.js"
set "NATIVE_NODE_MODULES=%SCRIPT_DIR%resources\\app.asar.unpacked\\node_modules"
set "APP_BIN="

if not exist "%CLI_ENTRY%" (
  echo BitSentry CLI entrypoint not found: %CLI_ENTRY% 1>&2
  exit /b 1
)

${candidateAssignments}

if not defined APP_BIN (
  echo Unable to locate the packaged BitSentry Desktop executable in %SCRIPT_DIR% 1>&2
  exit /b 1
)

set "ELECTRON_RUN_AS_NODE=1"
set "NODE_PATH=%NATIVE_NODE_MODULES%"
set "${CLI_WRAPPER_NODE_PATH_ENV}=%NATIVE_NODE_MODULES%"
"%APP_BIN%" "%CLI_ENTRY%" %*
exit /b %ERRORLEVEL%
`,
    'utf-8',
  )
}

export async function runAfterPack(
  context: AfterPackContextLike,
  projectRoot: string,
): Promise<void> {
  switch (context.electronPlatformName) {
    case 'darwin':
      await createMacCliWrapper(context, projectRoot)
      return
    case 'linux':
      await createLinuxCliWrapper(context, projectRoot)
      return
    case 'win32':
      await createWindowsCliWrapper(context, projectRoot)
      return
    default:
      throw new Error(`Unsupported platform for CLI wrapper generation: ${String(context.electronPlatformName)}`)
  }
}
