import {
  DesktopJobRuntime,
  type DesktopJobRuntimeDatabase,
  type DesktopJobRuntimeDependencies,
} from './desktop-job-runtime'

export type DesktopJobRuntimeClass<TDb extends DesktopJobRuntimeDatabase> = new (db: TDb) => DesktopJobRuntime

export function createDesktopJobRuntimeClass<
  TDb extends DesktopJobRuntimeDatabase,
>(
  dependencies: DesktopJobRuntimeDependencies,
): DesktopJobRuntimeClass<TDb> {
  return class JobRuntime extends DesktopJobRuntime {
    constructor(db: TDb) {
      super(db, dependencies)
    }
  }
}
