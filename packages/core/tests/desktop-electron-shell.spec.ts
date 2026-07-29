import { describe, expect, it } from 'vitest'

import { createDesktopPermissionRequestHandler } from '../src/features/desktop/desktop-electron-shell'

describe('Desktop Electron permission requests', () => {
  it('allows sanitized clipboard writes and denies unrelated permissions', () => {
    const decisions: boolean[] = []
    const handler = createDesktopPermissionRequestHandler()

    handler({}, 'clipboard-sanitized-write', (allowed: boolean) => {
      decisions.push(allowed)
    })
    handler({}, 'media', (allowed: boolean) => {
      decisions.push(allowed)
    })

    expect(decisions).toEqual([true, false])
  })
})
