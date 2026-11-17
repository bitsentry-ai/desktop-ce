import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  enableCompileCache: vi.fn(),
  getPath: vi.fn(),
  getSwitchValue: vi.fn(),
}))

vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  enableCompileCache: mocks.enableCompileCache,
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    commandLine: { getSwitchValue: mocks.getSwitchValue },
    on: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
  },
}))

// The bootstrap loads the whole main process afterwards; only its cache choice is under test.
vi.mock('../main/platform/app/electron/main', () => ({}))

/** Runs the startup bootstrap once with `userDataDir` as the --user-data-dir switch value ('' when absent). */
async function bootWith(userDataDir: string): Promise<string> {
  mocks.getSwitchValue.mockImplementation((name: string) => (name === 'user-data-dir' ? userDataDir : ''))
  vi.resetModules()
  await import('../main/platform/app/electron/index')
  expect(mocks.enableCompileCache).toHaveBeenCalledTimes(1)
  return mocks.enableCompileCache.mock.calls[0][0] as string
}

beforeEach(() => {
  mocks.enableCompileCache.mockReset()
  mocks.getSwitchValue.mockReset()
  mocks.getPath.mockReset()
  mocks.getPath.mockImplementation((name: string) => (name === 'appData' ? '/home/engineer/AppData' : `/unexpected/${name}`))
})

describe('compile cache location at startup', () => {
  it('keeps the cache inside an isolated profile chosen with --user-data-dir', async () => {
    expect(await bootWith('/Users/qa/isolated-profile')).toBe(path.join('/Users/qa/isolated-profile', 'compile-cache'))
  })

  it('resolves a relative --user-data-dir before using it', async () => {
    expect(await bootWith('qa-profile')).toBe(path.resolve('qa-profile', 'compile-cache'))
  })

  it('keeps the edition folder the app uses as its own profile when no profile is chosen', async () => {
    expect(await bootWith('')).toBe(path.join('/home/engineer/AppData', 'BitSentry Desktop', 'compile-cache'))
  })
})
