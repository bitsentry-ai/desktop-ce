import { randomUUID } from 'crypto'

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface JobRunRecord {
  id: string
  type: string
  status: JobStatus
  payload?: unknown
  result?: unknown
  error?: string
  attempt: number
  maxAttempts: number
  timeoutMs: number
  scheduledAt?: Date
  startedAt?: Date
  completedAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface EnqueueOptions {
  type: string
  payload?: unknown
  maxAttempts?: number
  timeoutMs?: number
  scheduledAt?: Date
}

export interface JobScheduleRecord {
  jobKey: string
  cronExpression: string
  enabled: boolean
  lastRunAt?: Date
  nextRunAt?: Date
  catchUpWindowHours: number
  createdAt: Date
  updatedAt: Date
}

export interface UpsertScheduleOptions {
  jobKey: string
  cronExpression: string
  enabled?: boolean
  catchUpWindowHours?: number
}

export type JobHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>

const TICK_INTERVAL_MS = 2000
const MAX_CONCURRENT = 2
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_CATCHUP_WINDOW_HOURS = 24

interface ExecutableJob {
  id: string
  type: string
  attempt: number
  maxAttempts: number
  timeoutMs: number
  payload: unknown
}

type DesktopJobRuntimeRow = Record<string, unknown>

interface DesktopJobRunTable {
  create(args: { data: Record<string, unknown> }): Promise<DesktopJobRuntimeRow>
  findUnique(args: { where: { id: string } }): Promise<DesktopJobRuntimeRow | null>
  update(args: {
    where: { id: string }
    data: Record<string, unknown>
  }): Promise<DesktopJobRuntimeRow>
  updateMany(args: {
    where: Record<string, unknown>
    data: Record<string, unknown>
  }): Promise<{ count: number }>
  findMany(args: Record<string, unknown>): Promise<DesktopJobRuntimeRow[]>
  findFirst(args: Record<string, unknown>): Promise<DesktopJobRuntimeRow | null>
}

interface DesktopJobScheduleTable {
  findMany(args: Record<string, unknown>): Promise<DesktopJobRuntimeRow[]>
  upsert(args: {
    where: { jobKey: string }
    create: Record<string, unknown>
    update: Record<string, unknown>
  }): Promise<DesktopJobRuntimeRow>
  findUnique(args: { where: { jobKey: string } }): Promise<DesktopJobRuntimeRow | null>
  update(args: {
    where: { jobKey: string }
    data: Record<string, unknown>
  }): Promise<DesktopJobRuntimeRow>
}

export interface DesktopJobRuntimeDatabase {
  jobRun: DesktopJobRunTable
  jobSchedule: DesktopJobScheduleTable
}

export interface DesktopJobRuntimeLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

export interface DesktopJobScheduledTask {
  stop(): void | Promise<void>
}

export interface DesktopJobRuntimeCron {
  validate(expression: string): boolean
  schedule(
    expression: string,
    callback: () => void,
    options: { timezone: string },
  ): DesktopJobScheduledTask
}

export interface DesktopJobRuntimeDependencies {
  logger: DesktopJobRuntimeLogger
  cron: DesktopJobRuntimeCron
}

function serializeNullableJson(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  return JSON.stringify(value)
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return undefined
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function optionalDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return value
  }

  return undefined
}

function nullableDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value
  }

  return null
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function retryDelayMs(attempt: number): number {
  return Math.pow(2, attempt - 1) * 1000
}

function shouldCatchUpSchedule(
  lastRunAt: Date | null,
  nowMs: number,
  intervalMs: number,
  catchUpWindowMs: number,
): boolean {
  if (lastRunAt === null) {
    return true
  }

  const elapsedMs = nowMs - lastRunAt.getTime()
  return elapsedMs >= intervalMs && elapsedMs <= catchUpWindowMs
}

function shouldSkipQueuedScheduleRun(
  existingQueued: Record<string, unknown> | null,
  lastRunAt: Date | null,
): boolean {
  if (existingQueued === null || lastRunAt === null) {
    return false
  }

  const createdAt = nullableDate(existingQueued.createdAt)
  if (createdAt === null) {
    return false
  }

  return createdAt.getTime() >= lastRunAt.getTime()
}

export class DesktopJobRuntime {
  private handlers = new Map<string, JobHandler>()
  private runningJobs = new Map<string, AbortController>()
  private scheduledTasks = new Map<string, DesktopJobScheduledTask>()
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private paused = false
  private catchUpComplete = false

  constructor(
    private readonly db: DesktopJobRuntimeDatabase,
    private readonly dependencies: DesktopJobRuntimeDependencies,
  ) {}

  registerHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  async enqueue(options: EnqueueOptions): Promise<JobRunRecord> {
    const row = await this.db.jobRun.create({
      data: {
        id: randomUUID(),
        type: options.type,
        status: 'queued',
        payload: serializeNullableJson(options.payload),
        result: null,
        error: null,
        attempt: 0,
        maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        scheduledAt: options.scheduledAt ?? null,
        startedAt: null,
        completedAt: null,
      },
    })
    return this.toDomain(row)
  }

  async cancel(id: string): Promise<JobRunRecord | null> {
    const job = await this.db.jobRun.findUnique({ where: { id } })
    if (job === null) return null

    const status = job.status as string
    if (isTerminalStatus(status)) {
      return this.toDomain(job)
    }

    const controller = this.runningJobs.get(id)
    if (controller !== undefined) {
      controller.abort()
    }

    await this.db.jobRun.updateMany({
      where: { id, status: { in: ['queued', 'running'] } },
      data: { status: 'cancelled', completedAt: new Date() },
    })
    const row = await this.db.jobRun.findUnique({ where: { id } })
    return row === null ? null : this.toDomain(row)
  }

  async retry(id: string): Promise<JobRunRecord | null> {
    const job = await this.db.jobRun.findUnique({ where: { id } })
    if (job === null) return null

    const status = job.status as string
    if (status !== 'failed' && status !== 'cancelled') {
      return this.toDomain(job)
    }

    await this.db.jobRun.updateMany({
      where: { id, status, attempt: job.attempt },
      data: {
        status: 'queued',
        error: null,
        result: null,
        attempt: 0,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
      },
    })
    const row = await this.db.jobRun.findUnique({ where: { id } })
    return row === null ? null : this.toDomain(row)
  }

  async getStatus(id: string): Promise<JobRunRecord | null> {
    const row = await this.db.jobRun.findUnique({ where: { id } })
    if (row === null) {
      return null
    }

    return this.toDomain(row)
  }

  async list(filter?: { status?: string; type?: string }): Promise<JobRunRecord[]> {
    const where: Record<string, unknown> = {}
    if (filter?.status !== undefined && filter.status.length > 0) where.status = filter.status
    if (filter?.type !== undefined && filter.type.length > 0) where.type = filter.type
    let whereClause: Record<string, unknown> | undefined
    if (Object.keys(where).length > 0) {
      whereClause = where
    }

    const rows = await this.db.jobRun.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    })
    return rows.map((r) => this.toDomain(r))
  }

  async listSchedules(): Promise<JobScheduleRecord[]> {
    const rows = await this.db.jobSchedule.findMany({
      orderBy: { jobKey: 'asc' },
    })
    return rows.map((row) => this.toScheduleDomain(row))
  }

  async upsertSchedule(options: UpsertScheduleOptions): Promise<JobScheduleRecord> {
    if (!this.dependencies.cron.validate(options.cronExpression)) {
      throw new Error(`Invalid cron expression: ${options.cronExpression}`)
    }

    const now = new Date()
    const row = await this.db.jobSchedule.upsert({
      where: { jobKey: options.jobKey },
      create: {
        jobKey: options.jobKey,
        cronExpression: options.cronExpression,
        enabled: options.enabled ?? true,
        catchUpWindowHours: options.catchUpWindowHours ?? DEFAULT_CATCHUP_WINDOW_HOURS,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        cronExpression: options.cronExpression,
        enabled: options.enabled ?? true,
        catchUpWindowHours: options.catchUpWindowHours ?? DEFAULT_CATCHUP_WINDOW_HOURS,
        updatedAt: now,
      },
    })

    if (this.tickTimer !== null) {
      await this.syncCronSchedules()
    }
    return this.toScheduleDomain(row)
  }

  async toggleSchedule(jobKey: string, enabled: boolean): Promise<JobScheduleRecord | null> {
    const existing = await this.db.jobSchedule.findUnique({
      where: { jobKey },
    })
    if (existing === null) return null
    const row = await this.db.jobSchedule.update({
      where: { jobKey },
      data: { enabled, updatedAt: new Date() },
    })
    if (this.tickTimer !== null) {
      await this.syncCronSchedules()
    }
    return this.toScheduleDomain(row)
  }

  async resumePending(): Promise<number> {
    const result = await this.db.jobRun.updateMany({
      where: { status: 'running' },
      data: { status: 'queued', startedAt: null },
    })
    const count = result.count
    if (count > 0) {
      this.dependencies.logger.info(
        `[jobs] Recovered ${String(count)} stale running job(s) to queued`,
      )
    }
    return count
  }

  start(): void {
    if (this.tickTimer !== null) return
    this.paused = false
    void this.syncCronSchedules()
      .then(() => this.runScheduleCatchUp())
      .catch((error: unknown) => {
        this.dependencies.logger.error('[jobs] Failed to initialize cron schedules:', error)
      })
    this.tickTimer = setInterval(() => {
      void this.tick()
    }, TICK_INTERVAL_MS)
    this.dependencies.logger.info('[jobs] Job runtime started')
  }

  stop(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }

    for (const [, task] of this.scheduledTasks) {
      this.stopTask(task)
    }
    this.scheduledTasks.clear()
    this.catchUpComplete = false

    for (const [id, controller] of this.runningJobs) {
      controller.abort()
      this.dependencies.logger.info(`[jobs] Aborted running job ${id} on shutdown`)
    }
    this.runningJobs.clear()

    this.dependencies.logger.info('[jobs] Job runtime stopped')
    return Promise.resolve()
  }

  pause(): void {
    this.paused = true
    this.dependencies.logger.info('[jobs] Job runtime paused')
  }

  resume(): void {
    this.paused = false
    this.dependencies.logger.info('[jobs] Job runtime resumed')
  }

  private async tick(): Promise<void> {
    if (this.paused) return
    if (this.runningJobs.size >= MAX_CONCURRENT) return

    try {
      const slotsAvailable = MAX_CONCURRENT - this.runningJobs.size
      const now = new Date()

      const candidates = await this.db.jobRun.findMany({
        where: {
          status: 'queued',
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: slotsAvailable,
      })

      for (const candidate of candidates) {
        if (this.runningJobs.size >= MAX_CONCURRENT) break
        void this.executeJob(candidate).catch((error: unknown) => {
          this.dependencies.logger.error('[jobs] Execution failed:', error)
        })
      }
    } catch (error) {
      this.dependencies.logger.error('[jobs] Tick error:', error)
    }
  }

  private async executeJob(row: DesktopJobRuntimeRow): Promise<void> {
    const job = this.toExecutableJob(row)
    if (this.runningJobs.has(job.id)) return
    const controller = new AbortController()
    this.runningJobs.set(job.id, controller)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const claimed = await this.markJobRunning(job)
      if (!claimed) return
      const handler = this.handlers.get(job.type)
      if (handler === undefined) {
        await this.failMissingHandler(job)
        return
      }
      if (controller.signal.aborted) {
        await this.failAbortedJob(job)
        return
      }
      timeout = setTimeout(() => controller.abort(), job.timeoutMs)
      const result = await handler(job.payload, controller.signal)
      if (controller.signal.aborted) {
        await this.failAbortedJob(job)
        return
      }
      await this.completeJob(job, result)
    } catch (error: unknown) {
      await this.handleJobError(job, controller, error)
    } finally {
      clearTimeout(timeout)
      this.runningJobs.delete(job.id)
    }
  }

  private toExecutableJob(row: DesktopJobRuntimeRow): ExecutableJob {
    return {
      id: row.id as string,
      type: row.type as string,
      attempt: (row.attempt as number) + 1,
      maxAttempts: row.maxAttempts as number,
      timeoutMs: row.timeoutMs as number,
      payload: parseStoredJson(row.payload),
    }
  }

  private async failMissingHandler(job: ExecutableJob): Promise<void> {
    await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'failed',
        error: `No handler registered for job type: ${job.type}`,
        completedAt: new Date(),
      },
    })
  }

  private async markJobRunning(job: ExecutableJob): Promise<boolean> {
    const claimed = await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'queued' },
      data: { status: 'running', attempt: job.attempt, startedAt: new Date() },
    })
    return claimed.count === 1
  }

  private async completeJob(job: ExecutableJob, result: unknown): Promise<void> {
    await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'completed',
        result: serializeNullableJson(result),
        completedAt: new Date(),
      },
    })

    this.dependencies.logger.info(
      `[jobs] Job ${job.id} (${job.type}) completed on attempt ${String(job.attempt)}`,
    )
  }

  private async handleJobError(
    job: ExecutableJob,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (this.isJobAbort(controller, error)) {
      await this.failAbortedJob(job)
      return
    }

    const errorMessage = getErrorMessage(error)
    if (job.attempt < job.maxAttempts) {
      await this.requeueFailedJob(job, errorMessage)
      return
    }

    await this.failExhaustedJob(job, errorMessage)
  }

  private isJobAbort(controller: AbortController, error: unknown): boolean {
    return controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
  }

  private async failAbortedJob(job: ExecutableJob): Promise<void> {
    await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'failed',
        error: 'Job timed out',
        completedAt: new Date(),
      },
    })
    this.dependencies.logger.warn(`[jobs] Job ${job.id} (${job.type}) aborted/timed out`)
  }

  private async requeueFailedJob(job: ExecutableJob, errorMessage: string): Promise<void> {
    const delayMs = retryDelayMs(job.attempt)
    const nextRun = new Date(Date.now() + delayMs)
    await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'queued',
        error: errorMessage,
        scheduledAt: nextRun,
        startedAt: null,
      },
    })
    this.dependencies.logger.info(
      `[jobs] Job ${job.id} (${job.type}) failed attempt ${String(job.attempt)}/${String(job.maxAttempts)}, retrying in ${String(delayMs)}ms`,
    )
  }

  private async failExhaustedJob(job: ExecutableJob, errorMessage: string): Promise<void> {
    await this.db.jobRun.updateMany({
      where: { id: job.id, status: 'running', attempt: job.attempt },
      data: {
        status: 'failed',
        error: errorMessage,
        completedAt: new Date(),
      },
    })
    this.dependencies.logger.error(
      `[jobs] Job ${job.id} (${job.type}) failed after ${String(job.attempt)} attempt(s): ${errorMessage}`,
    )
  }

  private stopTask(task: DesktopJobScheduledTask): void {
    void task.stop()
  }

  private replaceScheduledTask(jobKey: string, cronExpression: string): void {
    const existingTask = this.scheduledTasks.get(jobKey)
    if (existingTask !== undefined) {
      this.stopTask(existingTask)
    }

    const task = this.dependencies.cron.schedule(
      cronExpression,
      () => {
        void this.enqueueScheduleRun(jobKey, 'cron')
      },
      { timezone: 'UTC' },
    )
    this.scheduledTasks.set(jobKey, task)
  }

  private shouldSkipSchedule(schedule: DesktopJobRuntimeRow): boolean {
    const jobKey = String(schedule.jobKey)
    const cronExpression = String(schedule.cronExpression)
    if (this.dependencies.cron.validate(cronExpression)) {
      return false
    }

    this.dependencies.logger.warn(
      `[jobs] Skipping invalid cron expression for ${jobKey}: ${cronExpression}`,
    )
    return true
  }

  private scheduleCatchUpWindowMs(schedule: DesktopJobRuntimeRow): number {
    const catchUpWindowHours = Number(schedule.catchUpWindowHours ?? DEFAULT_CATCHUP_WINDOW_HOURS)
    return Math.max(1, catchUpWindowHours) * 60 * 60 * 1000
  }

  private async catchUpSchedule(schedule: DesktopJobRuntimeRow, nowMs: number): Promise<void> {
    const jobKey = String(schedule.jobKey)
    const intervalMs = this.estimateCronIntervalMs(String(schedule.cronExpression))
    const lastRunAt = nullableDate(schedule.lastRunAt)
    if (
      shouldCatchUpSchedule(lastRunAt, nowMs, intervalMs, this.scheduleCatchUpWindowMs(schedule))
    ) {
      await this.enqueueScheduleRun(jobKey, 'catchup')
    }
  }

  private async shouldSkipCurrentScheduleRun(jobKey: string): Promise<boolean> {
    const current = await this.db.jobSchedule.findUnique({ where: { jobKey } })
    if (current === null || current.enabled !== true) {
      return true
    }

    const lastRunAt = nullableDate(current.lastRunAt)
    const existingQueued = await this.db.jobRun.findFirst({
      where: {
        type: jobKey,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    })
    return shouldSkipQueuedScheduleRun(existingQueued, lastRunAt)
  }

  private async updateScheduleAfterEnqueue(jobKey: string): Promise<void> {
    const current = await this.db.jobSchedule.findUnique({ where: { jobKey } })
    if (current === null) {
      return
    }

    await this.db.jobSchedule.update({
      where: { jobKey },
      data: {
        lastRunAt: new Date(),
        nextRunAt: new Date(
          Date.now() + this.estimateCronIntervalMs(String(current.cronExpression)),
        ),
      },
    })
  }

  private async syncCronSchedules(): Promise<void> {
    const schedules = await this.db.jobSchedule.findMany({
      where: { enabled: true },
    })

    const enabledKeys = new Set(schedules.map((schedule) => String(schedule.jobKey)))
    for (const [jobKey, task] of this.scheduledTasks) {
      if (!enabledKeys.has(jobKey)) {
        this.stopTask(task)
        this.scheduledTasks.delete(jobKey)
      }
    }

    for (const schedule of schedules) {
      const jobKey = String(schedule.jobKey)
      const cronExpression = String(schedule.cronExpression)
      if (this.shouldSkipSchedule(schedule)) {
        continue
      }

      this.replaceScheduledTask(jobKey, cronExpression)
    }
  }

  private async runScheduleCatchUp(): Promise<void> {
    if (this.catchUpComplete) return

    const schedules = await this.db.jobSchedule.findMany({
      where: { enabled: true },
      orderBy: { jobKey: 'asc' },
    })
    const nowMs = Date.now()

    for (const schedule of schedules) {
      await this.catchUpSchedule(schedule, nowMs)
    }

    this.catchUpComplete = true
  }

  private async enqueueScheduleRun(jobKey: string, trigger: 'cron' | 'catchup'): Promise<void> {
    if (await this.shouldSkipCurrentScheduleRun(jobKey)) {
      return
    }

    await this.enqueue({
      type: jobKey,
      payload: { trigger, at: new Date().toISOString() },
    })
    await this.updateScheduleAfterEnqueue(jobKey)
  }

  private estimateCronIntervalMs(expression: string): number {
    if (expression.startsWith('*/')) {
      const everyMinutes = Number(expression.split(' ')[0].replace('*/', ''))
      if (Number.isFinite(everyMinutes) && everyMinutes > 0) {
        return everyMinutes * 60 * 1000
      }
    }
    if (expression.startsWith('0 *')) {
      return 60 * 60 * 1000
    }
    if (expression.startsWith('0 0')) {
      return 24 * 60 * 60 * 1000
    }
    return 60 * 60 * 1000
  }

  private toScheduleDomain(row: DesktopJobRuntimeRow): JobScheduleRecord {
    const schedule: JobScheduleRecord = {
      jobKey: String(row.jobKey),
      cronExpression: String(row.cronExpression),
      enabled: Boolean(row.enabled),
      catchUpWindowHours: Number(row.catchUpWindowHours ?? DEFAULT_CATCHUP_WINDOW_HOURS),
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    }
    const lastRunAt = optionalDate(row.lastRunAt)
    if (lastRunAt !== undefined) {
      schedule.lastRunAt = lastRunAt
    }
    const nextRunAt = optionalDate(row.nextRunAt)
    if (nextRunAt !== undefined) {
      schedule.nextRunAt = nextRunAt
    }

    return schedule
  }

  private toDomain(row: DesktopJobRuntimeRow): JobRunRecord {
    const job: JobRunRecord = {
      id: row.id as string,
      type: row.type as string,
      status: row.status as JobStatus,
      payload: parseStoredJson(row.payload),
      result: parseStoredJson(row.result),
      attempt: row.attempt as number,
      maxAttempts: row.maxAttempts as number,
      timeoutMs: row.timeoutMs as number,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    }
    if (typeof row.error === 'string') {
      job.error = row.error
    }
    const scheduledAt = optionalDate(row.scheduledAt)
    if (scheduledAt !== undefined) {
      job.scheduledAt = scheduledAt
    }
    const startedAt = optionalDate(row.startedAt)
    if (startedAt !== undefined) {
      job.startedAt = startedAt
    }
    const completedAt = optionalDate(row.completedAt)
    if (completedAt !== undefined) {
      job.completedAt = completedAt
    }

    return job
  }
}
