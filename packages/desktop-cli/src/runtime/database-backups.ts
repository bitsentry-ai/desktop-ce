import path from 'path'
import { access, copyFile, mkdir, readdir, stat, unlink } from 'fs/promises'
import log from './cli-log.js'
import { getRuntimeUserDataPath } from './runtime-paths.js'

const BACKUP_RETENTION_COUNT = 5

function getBackupDirectory(): string {
  return path.join(getRuntimeUserDataPath(), 'db-backups')
}

export function isDatabaseBackupEnabled(): boolean {
  return (process.env.BITSENTRY_ENABLE_DB_BACKUPS ?? '').trim().toLowerCase() === 'true'
}

function getTimestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function pruneBackupSnapshots(backupDir: string): Promise<void> {
  const names = await readdir(backupDir)
  const snapshots = (
    await Promise.all(
      names
        .filter((name) => name.endsWith('.sqlite'))
        .map(async (name) => {
          const fullPath = path.join(backupDir, name)
          const fileStat = await stat(fullPath)
          return { fullPath, mtimeMs: fileStat.mtimeMs }
        }),
    )
  ).sort((left, right) => right.mtimeMs - left.mtimeMs)

  const stale = snapshots.slice(BACKUP_RETENTION_COUNT)
  await Promise.all(stale.map((snapshot) => unlink(snapshot.fullPath)))
}

export async function createDatabaseSnapshot(databasePath: string): Promise<string | null> {
  if (!(await pathExists(databasePath))) {
    return null
  }

  const backupDir = getBackupDirectory()
  await mkdir(backupDir, { recursive: true })

  const backupPath = path.join(
    backupDir,
    `bitsentry-${getTimestampSuffix()}.sqlite`,
  )
  await copyFile(databasePath, backupPath)
  await pruneBackupSnapshots(backupDir)
  log.info(`[database] Created backup snapshot: ${backupPath}`)
  return backupPath
}

export async function restoreDatabaseSnapshot(
  backupPath: string,
  databasePath: string,
): Promise<void> {
  await copyFile(backupPath, databasePath)
  log.warn(`[database] Restored database from snapshot: ${backupPath}`)
}
