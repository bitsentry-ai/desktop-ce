import { builtinModules, createRequire } from 'module'
import { resolve } from 'path'
import { defineConfig } from 'vite'

const electronTrpcPackageRoot = resolve(
  __dirname,
  '../../packages/electron-trpc/packages/electron-trpc',
)
const desktopRequire = createRequire(resolve(__dirname, 'package.json'))
const cliExternals = new Set(['electron', 'better-sqlite3', 'node-pty', '@napi-rs/keyring'])
const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleId) => `node:${moduleId}`),
  ...builtinModules.map((moduleId) => moduleId.replace(/^node:/, '')),
])

export default defineConfig({
  plugins: [
    {
      name: 'bitsentry-ce-cli-workspace-resolver',
      enforce: 'pre',
      resolveId(source) {
        if (
          source.startsWith('.') ||
          source.startsWith('/') ||
          source.startsWith('\0') ||
          source.startsWith('@bitsentry') ||
          source === 'electron-log' ||
          source === 'electron-trpc/main' ||
          cliExternals.has(source) ||
          nodeBuiltinModules.has(source)
        ) {
          return null
        }

        try {
          return desktopRequire.resolve(source)
        } catch {
          return null
        }
      },
    },
  ],
  define: {
    'process.env.BITSENTRY_SENTRY_DSN': JSON.stringify(
      process.env.BITSENTRY_SENTRY_DSN ?? '',
    ),
    'process.env.BITSENTRY_RELEASE_CHANNEL': JSON.stringify(
      process.env.BITSENTRY_RELEASE_CHANNEL ?? 'stable',
    ),
  },
  ssr: {
    noExternal: true,
    external: [
      'electron',
      'better-sqlite3',
      'node-pty', '@napi-rs/keyring',
    ],
  },
  build: {
    emptyOutDir: false,
    outDir: resolve(__dirname, 'out/cli-bundle'),
    target: 'node20',
    sourcemap: false,
    ssr: resolve(
      __dirname,
      '../../packages/desktop-cli/src/cli/desktop-runbooks-entry.ts',
    ),
    rollupOptions: {
      external: ['electron', 'better-sqlite3', 'node-pty', '@napi-rs/keyring'],
      output: {
        entryFileNames: 'cli.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'cjs',
      },
    },
    commonjsOptions: {
      include: [/node_modules/],
    },
  },
  resolve: {
    alias: {
      '@bitsentry/core': resolve(__dirname, '../../packages/core/src'),
      '@bitsentry/components': resolve(__dirname, '../../packages/components/src'),
      '@bitsentry-ce/desktop-cli': resolve(__dirname, '../../packages/desktop-cli/src'),
      '@bitsentry-ce/coding-agents': resolve(__dirname, '../../packages/coding-agents/src'),
      '@bitsentry-ce/core': resolve(__dirname, '../../packages/core/src'),
      '@bitsentry-ce/components': resolve(__dirname, '../../packages/components/src'),
      '@bitsentry-desktop/runbook-runtime': resolve(
        __dirname,
        'src/main/platform/runbooks/desktop-runbook-runtime.ts',
      ),
      '@bitsentry-ce/i18n': resolve(__dirname, '../../packages/i18n/src'),
      'electron-log': resolve(
        __dirname,
        '../../packages/desktop-cli/src/runtime/cli-log.ts',
      ),
      'electron-trpc/main': resolve(electronTrpcPackageRoot, 'src/main/index.ts'),
    },
  },
})
