import { describe, expect, it } from 'vitest'

import { formatDesktopStartupFingerprint } from '../../main/platform/app/electron/startup-fingerprint'

describe('desktop startup fingerprint', () => {
  it('logs one line with the build SHA and startup timestamp', () => {
    expect(formatDesktopStartupFingerprint(
      '4ad9d7b775cb3c1dc11655be5dffce410136d323',
      '2026-08-03T01:09:00.000Z',
    )).toBe(
      '[main] startup fingerprint buildGitSha=4ad9d7b775cb3c1dc11655be5dffce410136d323 startedAt=2026-08-03T01:09:00.000Z',
    )
  })
})
