let idleTtlMs = 30_000

export interface ProcessLease<T> {
  ready: Promise<T>
  /** Keeps new turns off this process; it closes once no turn holds it. */
  retire(): void
  /** Retires the process and kills it now unless another turn is using it. */
  abort(): void
  release(): Promise<void>
}

export interface ProcessPoolAdapter<Spec, T> {
  /** Everything that shapes the launch, so different configs never share a process. */
  keyFor(spec: Spec): string
  /** Allocates the process without waiting for it to be usable. */
  create(spec: Spec): Promise<T>
  /** Resolves once the process can serve turns; `onExit` retires it. */
  start(process: T, onExit: () => void): Promise<void>
  close(process: T): Promise<void>
  /** Lends each process to one turn at a time. */
  exclusive?: boolean
}

interface PooledProcess<T> {
  key: string
  borrowers: number
  retired: boolean
  idleTimer: ReturnType<typeof setTimeout> | undefined
  ready: Promise<T>
  close(): Promise<void>
}

const live = new Set<{ close(): Promise<void> }>()

/**
 * Lends running CLI processes per turn, keyed by their launch config. An idle
 * process closes after a short TTL.
 */
export function createProcessPool<Spec, T>(adapter: ProcessPoolAdapter<Spec, T>): (spec: Spec) => ProcessLease<T> {
  const available = new Map<string, PooledProcess<T>>()

  const retire = (entry: PooledProcess<T>): void => {
    entry.retired = true
    if (available.get(entry.key) === entry) available.delete(entry.key)
    if (entry.borrowers === 0) void entry.close()
  }

  const open = (key: string, spec: Spec): PooledProcess<T> => {
    let closing: Promise<void> | undefined
    const created = adapter.create(spec)
    const shutdown = async (): Promise<void> => {
      clearTimeout(entry.idleTimer)
      entry.retired = true
      if (available.get(key) === entry) available.delete(key)
      live.delete(entry)
      const process = await created.catch(() => undefined)
      if (process !== undefined) await adapter.close(process)
    }
    const entry: PooledProcess<T> = {
      key,
      borrowers: 0,
      retired: false,
      idleTimer: undefined,
      ready: created.then(async (process) => {
        if (closing !== undefined) throw new Error('Process closed before it started')
        await adapter.start(process, () => { retire(entry) })
        return process
      }),
      close: () => {
        closing ??= shutdown()
        return closing
      },
    }
    entry.ready.catch(() => { retire(entry) })
    available.set(key, entry)
    live.add(entry)
    return entry
  }

  return (spec) => {
    const key = adapter.keyFor(spec)
    const entry = available.get(key) ?? open(key, spec)
    if (adapter.exclusive === true) available.delete(key)
    entry.borrowers += 1
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    let released = false

    return {
      ready: entry.ready,
      retire: () => { retire(entry) },
      abort: () => {
        retire(entry)
        if (entry.borrowers <= 1) void entry.close()
      },
      release: () => {
        if (released) return Promise.resolve()
        released = true
        entry.borrowers -= 1
        if (entry.borrowers > 0) return Promise.resolve()
        if (entry.retired) return entry.close()
        if (available.get(key) !== entry) {
          if (available.has(key)) return entry.close()
          available.set(key, entry)
        }
        entry.idleTimer = setTimeout(() => void entry.close(), idleTtlMs)
        entry.idleTimer.unref()
        return Promise.resolve()
      },
    }
  }
}

export async function closePooledProcesses(): Promise<void> {
  await Promise.all([...live].map((entry) => entry.close()))
}

export function setProcessPoolIdleTtlForTesting(ms: number): void {
  idleTtlMs = ms
}
