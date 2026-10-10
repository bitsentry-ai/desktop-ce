/**
 * Compile-time contract tests for CLI probe service.
 * Verifies exported function signatures match expected contracts.
 */

import { describe, expect, it } from 'vitest'
import { parseCursorAuthOutput } from '@bitsentry-ce/coding-agents/cli-probe.service'

describe('parseCursorAuthOutput', () => {
  it('treats bare unauthenticated text as unauthenticated', () => {
    expect(parseCursorAuthOutput('unauthenticated', '')).toEqual({
      status: 'unauthenticated',
    })
    expect(parseCursorAuthOutput('[error] unauthenticated', '')).toEqual({
      status: 'unauthenticated',
    })
  })

  it('treats logged-in text as authenticated', () => {
    expect(parseCursorAuthOutput('Logged in as wira@example.com', '')).toEqual({
      status: 'authenticated',
    })
  })

  it('treats Cursor about output with no account as unauthenticated', () => {
    expect(parseCursorAuthOutput('User Email          Not logged in', '')).toEqual({
      status: 'unauthenticated',
    })
  })
})
