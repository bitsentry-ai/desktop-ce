import log from 'electron-log'
import cron from 'node-cron'
import {
  DesktopJobRuntime,
  createDesktopJobRuntimeClass,
  type DesktopJobRuntimeCron,
  type DesktopJobRuntimeDatabase,
  type DesktopJobRuntimeLogger,
  type EnqueueOptions,
  type JobHandler,
  type JobRunRecord,
  type JobScheduleRecord,
  type JobStatus,
  type UpsertScheduleOptions,
} from '@bitsentry-ce/core/features/jobs'

const schedulerLogger: DesktopJobRuntimeLogger = log
const schedulerCron: DesktopJobRuntimeCron = {
  validate: cron.validate,
  schedule: (expression, callback, options) =>
    cron.schedule(expression, callback, options),
}

export type {
  DesktopJobRuntime,
  DesktopJobRuntimeDatabase,
  EnqueueOptions,
  JobHandler,
  JobRunRecord,
  JobScheduleRecord,
  JobStatus,
  UpsertScheduleOptions,
}

export function createDesktopSchedulerJobRuntime(
  db: DesktopJobRuntimeDatabase,
): DesktopJobRuntime {
  const JobRuntime = createDesktopJobRuntimeClass<DesktopJobRuntimeDatabase>({
    logger: schedulerLogger,
    cron: schedulerCron,
  })

  return new JobRuntime(db)
}
