import log from 'electron-log'
import { ErrorSourceSyncService } from './desktop-error-source-sync.service'

const STOP_WAIT_MS = 5_000

export class SyncSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Promise<void> | null = null
  private abortController: AbortController | null = null

  constructor(
    private readonly syncService: ErrorSourceSyncService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return

    this.timer = setInterval(() => {
      this.runScheduledSync()
    }, this.intervalMs)
  }

  /** Stops scheduling, aborts any in-flight sync and waits up to 5 s for it. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const inFlight = this.inFlight
    if (inFlight === null) return
    this.abortController?.abort()

    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      inFlight.then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, STOP_WAIT_MS) }),
    ])
    clearTimeout(timer)
    if (!settled) {
      log.warn(`[error-sources] Scheduled sync still running ${String(STOP_WAIT_MS)}ms after shutdown`)
    }
  }

  private runScheduledSync(): void {
    if (this.inFlight !== null) {
      log.info('[error-sources] Skipping scheduled sync; previous sync still running')
      return
    }

    const abortController = new AbortController()
    this.abortController = abortController
    this.inFlight = this.syncService
      .syncAllEnabled(abortController.signal)
      .then((results) => {
        const failed = results.filter((result) => Boolean(result.error)).length
        if (failed > 0) {
          log.warn(`[error-sources] Scheduled sync completed with ${String(failed)} failures`)
        }
      })
      .catch((error: unknown) => {
        log.warn('[error-sources] Scheduled sync failed:', error)
      })
      .finally(() => {
        this.inFlight = null
        this.abortController = null
      })
  }
}
