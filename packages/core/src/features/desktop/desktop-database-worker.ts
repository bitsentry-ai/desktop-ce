import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'

type SqliteParameter = string | number | bigint | Buffer | null
type WorkerReply = { id: number; rows?: unknown[]; error?: string }

// Inline source, so the worker needs no separate entry in the electron-vite build or electron-builder files.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const Database = require(workerData.driverPath)
const db = new Database(workerData.dbPath, { fileMustExist: true })
db.pragma('busy_timeout = 5000')
db.pragma('synchronous = NORMAL')
db.pragma('checkpoint_fullfsync = ON')
db.pragma('journal_size_limit = 33554432')
db.pragma('foreign_keys = ON')
const statements = new Map()
function prepare(sql) {
  let statement = statements.get(sql)
  if (statement === undefined) {
    if (statements.size >= 200) statements.delete(statements.keys().next().value)
    statement = db.prepare(sql)
    statements.set(sql, statement)
  }
  return statement
}
const checkpoints = setInterval(() => {
  // A busy or failed PASSIVE checkpoint is retried on the next tick.
  try { db.pragma('wal_checkpoint(PASSIVE)') } catch {}
}, workerData.checkpointMs)
parentPort.on('message', (request) => {
  if (request === 'close') {
    clearInterval(checkpoints)
    db.close()
    parentPort.close()
    return
  }
  try {
    parentPort.postMessage({ id: request.id, rows: prepare(request.sql).all(...request.parameters) })
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
})
parentPort.postMessage('ready')
`

const CHECKPOINT_INTERVAL_MS = 2000
// Matches busy_timeout, so a read waiting on a lock still gets to finish.
const CLOSE_TIMEOUT_MS = 5000

/**
 * A second better-sqlite3 connection on a worker thread. It runs WAL
 * checkpoints, whose fsyncs would otherwise stall the main event loop, and the
 * large reads routed to it. All writes stay on the main connection.
 */
export class SqliteWorker {
  private nextId = 0
  private readonly pending = new Map<number, { resolve(rows: unknown[]): void; reject(error: Error): void }>()

  private constructor(private readonly worker: Worker, onExit: () => void) {
    worker.unref()
    worker.on('message', (reply: WorkerReply) => this.settle(reply))
    worker.on('error', (error: Error) => this.failAll(error))
    worker.on('exit', () => {
      this.failAll(new Error('SQLite worker exited'))
      onExit()
    })
  }

  static start(dbPath: string, onExit: () => void): Promise<SqliteWorker> {
    const driverPath = createRequire(__filename).resolve('better-sqlite3')
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driverPath, dbPath, checkpointMs: CHECKPOINT_INTERVAL_MS },
    })
    return new Promise((resolve, reject) => {
      const fail = (error: unknown): void => {
        void worker.terminate()
        reject(error instanceof Error ? error : new Error('SQLite worker exited before it was ready'))
      }
      worker.once('error', fail)
      worker.once('exit', fail)
      worker.once('message', () => {
        worker.off('error', fail)
        worker.off('exit', fail)
        resolve(new SqliteWorker(worker, onExit))
      })
    })
  }

  all<T>(sql: string, parameters: SqliteParameter[]): Promise<T[]> {
    const id = this.nextId++
    // Hold the process open only while a caller is waiting on a reply.
    if (this.pending.size === 0) this.worker.ref()
    return new Promise<unknown[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, sql, parameters })
    }) as Promise<T[]>
  }

  /** Finishes queued reads, closes the worker's connection, then waits for the thread to exit. */
  async close(): Promise<void> {
    const exited = new Promise<void>((resolve) => this.worker.once('exit', () => resolve()))
    this.worker.ref()
    this.worker.postMessage('close')
    const timer = setTimeout(() => void this.worker.terminate(), CLOSE_TIMEOUT_MS)
    await exited
    clearTimeout(timer)
  }

  private settle(reply: WorkerReply): void {
    const request = this.pending.get(reply.id)
    if (request === undefined) return
    this.pending.delete(reply.id)
    if (this.pending.size === 0) this.worker.unref()
    if (reply.error === undefined) request.resolve(reply.rows ?? [])
    else request.reject(new Error(reply.error))
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}
