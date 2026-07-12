import path from 'path'
import { getRuntimeUserDataPath } from './runtime-paths.js'

export function getDatabasePath(): string {
  const userDataPath = getRuntimeUserDataPath()
  return path.join(userDataPath, 'bitsentry.db')
}

export function getDatabaseUrl(): string {
  return `file:${getDatabasePath()}`
}
