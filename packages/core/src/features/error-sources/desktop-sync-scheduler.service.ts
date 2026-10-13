import log from 'electron-log'
import { ErrorSourceSyncService } from './desktop-error-source-sync.service'

export class SyncSchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly syncService: ErrorSourceSyncService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return

    this.timer = setInterval(() => {
      void this.syncService
        .syncAllEnabled()
        .then((results) => {
          const failed = results.filter((result) => result.error).length
          if (failed > 0) {
            log.warn(`[error-sources] Scheduled sync completed with ${String(failed)} failures`)
          }
        })
        .catch((error: unknown) => {
          log.warn('[error-sources] Scheduled sync failed:', error)
        })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}
