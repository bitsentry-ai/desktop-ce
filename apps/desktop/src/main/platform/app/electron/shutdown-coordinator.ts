export interface DesktopShutdownActions {
  stopUpdater(): void | Promise<void>
  destroyAgentRuntime(): void | Promise<void>
  destroyCodingAgents(): void | Promise<void>
  closeSentry(): void | Promise<void>
  destroyRunbookExecution(): void | Promise<void>
  stopJobRuntime(): void | Promise<void>
  closeDatabase(): void | Promise<void>
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
    await this.actions.stopUpdater()
    await this.actions.destroyAgentRuntime()
    await this.actions.destroyCodingAgents()
    await this.actions.closeSentry()
    await this.actions.destroyRunbookExecution()
    await this.actions.stopJobRuntime()
    await this.actions.closeDatabase()
  }
}
