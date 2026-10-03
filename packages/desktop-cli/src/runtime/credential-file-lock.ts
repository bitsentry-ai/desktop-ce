import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'

/** Cross-process exclusion; never steal a lock merely because time elapsed. */
export async function withCredentialFileLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filename}.lock`
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('Could not acquire the credential-store lock. Check directory access; existing data was preserved.')
      }
      if (Date.now() >= deadline) {
        throw new Error('Credential storage is locked by another process. Close other Desktop/CLI processes and retry. After a crash, verify all processes using this profile have stopped before removing auth/plugins.json.lock. No data was changed.')
      }
      await setTimeout(25)
    }
  }
  try {
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), { mode: 0o600 })
    return await operation()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
