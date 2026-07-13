import { describe, expect, it } from 'vitest'

import { DESKTOP_RPC_CHANNELS } from '@bitsentry-ce/components/services'
import { validateIpcPayload } from '../main/platform/app/ipc/schemas'

describe('desktop IPC schema parity', () => {
  it('derives one payload schema for every router channel', () => {
    expect([...validateIpcPayload.schemas.keys()].sort()).toEqual(
      [...DESKTOP_RPC_CHANNELS].sort(),
    )
  })

  it('rejects a malformed null payload for every contract channel', () => {
    for (const channel of DESKTOP_RPC_CHANNELS) {
      expect(() => validateIpcPayload(channel, null)).toThrow()
    }
  })
})
