import { describe, expect, it } from 'vitest'
import {
  getAutoUpdaterEnablement,
  getUpdateDownloadPolicy,
} from '@bitsentry-ce/core/features/updater/desktop-updater-policy'

describe('getAutoUpdaterEnablement', () => {
  it('skips auto-updater during smoke tests', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: true,
        currentVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        releaseChannel: 'stable',
      }),
    ).toEqual({
      enabled: false,
      disabledReasonCode: 'smoke-test',
      feedUrl: null,
    })
  })

  it('skips auto-updater for unpackaged desktop runs', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: false,
        isSmokeTest: false,
        currentVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        releaseChannel: 'stable',
      }),
    ).toEqual({
      enabled: false,
      disabledReasonCode: 'not-packaged',
      feedUrl: null,
    })
  })

  it('enables auto-updater for packaged non-smoke runs with the canonical stable feed', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: false,
        currentVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        releaseChannel: 'stable',
      }),
    ).toEqual({
      enabled: true,
      disabledReasonCode: null,
      feedUrl: 'https://downloads.bitsentry.ai/desktop/releases/macos/arm64',
    })
  })

  it.each([
    ['darwin', 'arm64', 'https://downloads.bitsentry.ai/desktop/releases/macos/arm64'],
    ['darwin', 'x64', 'https://downloads.bitsentry.ai/desktop/releases/macos/x64'],
    ['win32', 'x64', 'https://downloads.bitsentry.ai/desktop/releases/windows/x64'],
    ['linux', 'x64', 'https://downloads.bitsentry.ai/desktop/releases/linux/x64'],
    ['linux', 'arm64', 'https://downloads.bitsentry.ai/desktop/releases/linux/arm64'],
  ] as const)(
    'maps %s/%s packaged builds to the correct canonical feed',
    (platform, arch, feedUrl) => {
      expect(
        getAutoUpdaterEnablement({
          isPackaged: true,
          isSmokeTest: false,
          currentVersion: '0.1.0',
          platform,
          arch,
          releaseChannel: 'stable',
        }),
      ).toEqual({
        enabled: true,
        disabledReasonCode: null,
        feedUrl,
      })
    },
  )

  it('repairs placeholder feeds by falling back to the canonical stable feed', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: false,
        currentVersion: '0.1.0',
        platform: 'win32',
        arch: 'x64',
        releaseChannel: 'stable',
        appUpdateConfigContents:
          'provider: generic\nurl: https://downloads.bitsentry.ai/desktop/releases/local-build-placeholder\n',
      }),
    ).toEqual({
      enabled: true,
      disabledReasonCode: null,
      feedUrl: 'https://downloads.bitsentry.ai/desktop/releases/windows/x64',
    })
  })

  it('repairs stable release feeds that still point at a versioned artifact directory', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: false,
        currentVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        releaseChannel: 'stable',
        appUpdateConfigContents:
          'provider: generic\nurl: https://downloads.bitsentry.ai/desktop/releases/macos/arm64/desktop-v0.1.0\n',
      }),
    ).toEqual({
      enabled: true,
      disabledReasonCode: null,
      feedUrl: 'https://downloads.bitsentry.ai/desktop/releases/macos/arm64',
    })
  })

  it('keeps a valid configured feed when one is already present', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: false,
        currentVersion: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        releaseChannel: 'stable',
        appUpdateConfigContents: 'provider: generic\nurl: https://updates.example.com/bitsentry-desktop\n',
      }),
    ).toEqual({
      enabled: true,
      disabledReasonCode: null,
      feedUrl: 'https://updates.example.com/bitsentry-desktop',
    })
  })

  it('disables auto-updater when there is no supported canonical feed fallback', () => {
    expect(
      getAutoUpdaterEnablement({
        isPackaged: true,
        isSmokeTest: false,
        currentVersion: '0.1.0-beta.1',
        platform: 'win32',
        arch: 'arm64',
        releaseChannel: 'stable',
        appUpdateConfigContents:
          'provider: generic\nurl: https://downloads.bitsentry.ai/desktop/releases/local-build-placeholder\n',
      }),
    ).toEqual({
      enabled: false,
      disabledReasonCode: 'unsupported-feed',
      feedUrl: null,
    })
  })

  it.each(['beta', 'preview'] as const)(
    'does not fall back to the stable feed for %s builds with an invalid packaged feed',
    (releaseChannel) => {
      expect(
        getAutoUpdaterEnablement({
          isPackaged: true,
          isSmokeTest: false,
          currentVersion: '0.1.0',
          platform: 'darwin',
          arch: 'arm64',
          releaseChannel,
          appUpdateConfigContents:
            'provider: generic\nurl: https://downloads.bitsentry.ai/desktop/releases/local-build-placeholder\n',
        }),
      ).toEqual({
        enabled: false,
        disabledReasonCode: 'unsupported-feed',
        feedUrl: null,
      })
    },
  )

  it.each([
    ['beta', 'https://downloads.bitsentry.ai/desktop/beta/review-branch'],
    ['preview', 'https://downloads.bitsentry.ai/desktop/previews/review-branch/123456'],
  ] as const)(
    'keeps a valid configured %s feed when one is already present',
    (releaseChannel, feedUrl) => {
      expect(
        getAutoUpdaterEnablement({
          isPackaged: true,
          isSmokeTest: false,
          currentVersion: '0.1.0',
          platform: 'darwin',
          arch: 'arm64',
          releaseChannel,
          appUpdateConfigContents: `provider: generic\nurl: ${feedUrl}\n`,
        }),
      ).toEqual({
        enabled: true,
        disabledReasonCode: null,
        feedUrl,
      })
    },
  )
})

describe('getUpdateDownloadPolicy', () => {
  it.each([
    ['0.1.0', '0.1.1', 'auto'],
    ['0.1.0', '0.2.0', 'auto'],
    ['0.1.0', '1.0.0', 'manual'],
    ['0.1.0', '0.1.1-beta.1', 'manual'],
  ] as const)('returns %s -> %s download policy', (currentVersion, availableVersion, expected) => {
    expect(
      getUpdateDownloadPolicy({
        currentVersion,
        availableVersion,
      }),
    ).toBe(expected)
  })
})
