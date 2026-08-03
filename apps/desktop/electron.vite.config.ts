import { resolve } from 'path'
import { execFileSync } from 'node:child_process'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

const electronTrpcPackageRoot = resolve(__dirname, '../../packages/electron-trpc/packages/electron-trpc')
const desktopNodeModules = resolve(__dirname, 'node_modules')

function resolveBuildGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

const buildGitSha = resolveBuildGitSha()

export default defineConfig({
  main: {
    define: {
      'process.env.BITSENTRY_SENTRY_DSN': JSON.stringify(process.env.BITSENTRY_SENTRY_DSN ?? ''),
      'process.env.BITSENTRY_RELEASE_CHANNEL': JSON.stringify(process.env.BITSENTRY_RELEASE_CHANNEL ?? 'stable'),
      'process.env.BITSENTRY_BUILD_GIT_SHA': JSON.stringify(buildGitSha),
    },
    build: {
      externalizeDeps: {
        exclude: [
          '@bitsentry-ce/desktop-cli',
          '@bitsentry-ce/coding-agents',
          '@bitsentry-ce/components',
          '@bitsentry-ce/core',
          '@bitsentry-ce/i18n',
          'electron-trpc',
        ],
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/platform/app/electron/index.ts'),
          cli: resolve(
            __dirname,
            '../../packages/desktop-cli/src/cli/desktop-runbooks-entry.ts',
          ),
        },
        external: [
          'better-sqlite3',
          'bcryptjs',
          'speakeasy',
          'qrcode',
          'jsonwebtoken',
          'node-pty',
        ],
      },
    },
    resolve: {
      alias: {
        '@bitsentry-ce/desktop-cli': resolve(__dirname, '../../packages/desktop-cli/src'),
        '@bitsentry-ce/coding-agents': resolve(__dirname, '../../packages/coding-agents/src'),
        '@bitsentry-ce/core': resolve(__dirname, '../../packages/core/src'),
        '@bitsentry-ce/components': resolve(__dirname, '../../packages/components/src'),
        '@bitsentry-desktop/runbook-runtime': resolve(
          __dirname,
          'src/main/platform/runbooks/desktop-runbook-runtime.ts',
        ),
        '@bitsentry-ce/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
        'electron-trpc/main': resolve(electronTrpcPackageRoot, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: {
        exclude: [
          '@bitsentry-ce/desktop-cli',
          '@bitsentry-ce/components',
          '@bitsentry-ce/coding-agents',
          '@bitsentry-ce/core',
          '@bitsentry-ce/i18n',
          // Must be bundled, not externalized. Sandboxed preload scripts
          // can't resolve `require('@sentry/electron/preload')` at runtime;
          // the package needs to be inlined into the preload bundle.
          '@sentry/electron',
        ],
      },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
    resolve: {
      alias: {
        '@bitsentry-ce/desktop-cli': resolve(__dirname, '../../packages/desktop-cli/src'),
        '@bitsentry-ce/coding-agents': resolve(__dirname, '../../packages/coding-agents/src'),
        '@bitsentry-ce/core': resolve(__dirname, '../../packages/core/src'),
        '@bitsentry-ce/components': resolve(__dirname, '../../packages/components/src'),
        '@bitsentry-ce/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    define: {
      'import.meta.env.VITE_POSTHOG_KEY': JSON.stringify(process.env.BITSENTRY_POSTHOG_KEY ?? ''),
      'import.meta.env.VITE_POSTHOG_HOST': JSON.stringify(
        process.env.BITSENTRY_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      ),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
      commonjsOptions: {
        include: [/packages\/components/, /packages\/core/, /node_modules/],
      },
    },
    plugins: [react()],
    resolve: {
      dedupe: [
        'react',
        'react-dom',
        'react-router',
        'react-router-dom',
        '@tanstack/react-query',
      ],
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        react: resolve(desktopNodeModules, 'react'),
        'react-dom': resolve(desktopNodeModules, 'react-dom'),
        '@tanstack/react-query': resolve(
          desktopNodeModules,
          '@tanstack/react-query',
        ),
        '@bitsentry-ce/coding-agents': resolve(
          __dirname,
          '../../packages/coding-agents/src',
        ),
        // Resolve workspace packages to source for proper ESM handling
        '@bitsentry-ce/components/services': resolve(
          __dirname,
          '../../packages/components/src/services/index.ts',
        ),
        '@bitsentry-ce/components': resolve(
          __dirname,
          '../../packages/components/src',
        ),
        '@bitsentry-ce/core': resolve(
          __dirname,
          '../../packages/core/src',
        ),
        '@bitsentry-ce/i18n': resolve(
          __dirname,
          '../../packages/i18n/src/index.ts',
        ),
        '@bitsentry-desktop/renderer-app': resolve(
          __dirname,
          'src/renderer/src/App.tsx',
        ),
        'electron-trpc/renderer': resolve(
          electronTrpcPackageRoot,
          'src/renderer/index.ts',
        ),
      },
    },
  },
})
