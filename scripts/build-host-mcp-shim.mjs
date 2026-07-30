import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceDirectory = resolve(scriptsDirectory, '..')
const source = resolve(workspaceDirectory, 'packages/coding-agents/src/host-mcp-shim.cjs')
const destination = resolve(workspaceDirectory, 'packages/coding-agents/dist/host-mcp-shim.cjs')

await mkdir(dirname(destination), { recursive: true })
await copyFile(source, destination)
