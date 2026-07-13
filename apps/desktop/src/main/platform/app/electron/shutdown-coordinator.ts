export interface DesktopShutdownActions {
  stopUpdater(): void | Promise<void>
  destroyAgentRuntime(): void | Promise<void>
  destroyCodingAgents(): void | Promise<void>
  closeSentry(): void | Promise<void>
  destroyRunbookExecution(): void | Promise<void>
  stopJobRuntime(): void | Promise<void>
  closeDatabase(): void | Promise<void>
  onShutdownError?(step: string, error: unknown): void
}

export interface BeforeQuitEvent {
  preventDefault(): void
}

export class DesktopShutdownCoordinator {
  private shutdownPromise: Promise<void> | null = null
  private mayQuit = false

  constructor(private readonly actions: DesktopShutdownActions) {}

  shutdown(): Promise<void> {
    if (this.shutdownPromise === null) {
      this.shutdownPromise = this.runShutdown()
    }
    return this.shutdownPromise
  }

  handleBeforeQuit(event: BeforeQuitEvent, quit: () => void): void {
    if (this.mayQuit) {
      return
    }

    event.preventDefault()
    const startsShutdown = this.shutdownPromise === null
    const shutdown = this.shutdown()
    if (!startsShutdown) {
      return
    }
    void shutdown.then(() => {
      this.mayQuit = true
      quit()
    })
  }

  private async runShutdown(): Promise<void> {
    await this.release('updater', () => this.actions.stopUpdater())
    await this.release('agent-runtime', () => this.actions.destroyAgentRuntime())
    await this.release('coding-agents', () => this.actions.destroyCodingAgents())
    await this.release('sentry', () => this.actions.closeSentry())
    await this.release('runbook-execution', () => this.actions.destroyRunbookExecution())
    await this.release('job-runtime', () => this.actions.stopJobRuntime())
    await this.release('database', () => this.actions.closeDatabase())
  }

  private async release(
    step: string,
    action: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await action()
    } catch (error) {
      this.actions.onShutdownError?.(step, error)
    }
  }
}
