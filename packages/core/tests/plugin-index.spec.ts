import { describe, expect, it } from 'vitest'

import { assertFirstPartyRemoteUrl } from '../src/features/plugins/desktop-plugin-index'

describe('first-party plugin URL policy', () => {
  it('allows artifacts from the Desktop CE GitHub release path', () => {
    expect(() =>
      assertFirstPartyRemoteUrl(
        'https://github.com/bitsentry-ai/desktop-ce/releases/download/plugin-catalog/sentry.plugin.js',
        'artifacts',
      ),
    ).not.toThrow()
  })

  it('rejects GitHub URLs outside the Desktop CE release path', () => {
    expect(() =>
      assertFirstPartyRemoteUrl(
        'https://github.com/bitsentry-ai/bitsentry-plugin-sentry/releases/download/v0.1.0/sentry.plugin.js',
        'artifacts',
      ),
    ).toThrow('Remote plugin artifacts')
  })

  it('rejects R2 URLs for plugin artifacts', () => {
    expect(() =>
      assertFirstPartyRemoteUrl(
        'https://plugins.bitsentry.ai/sentry.plugin.js',
        'artifacts',
      ),
    ).toThrow('Remote plugin artifacts')
  })

  it('keeps plugin indexes restricted to the R2 origin', () => {
    expect(() =>
      assertFirstPartyRemoteUrl(
        'https://github.com/bitsentry-ai/desktop-ce/releases/download/plugin-catalog/index.yaml',
        'indexes',
      ),
    ).toThrow('Remote plugin indexes')
  })
})
