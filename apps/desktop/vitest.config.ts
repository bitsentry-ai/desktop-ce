import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

const desktopNodeModules = resolve(__dirname, 'node_modules')

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: resolve(desktopNodeModules, 'react'),
      'react-dom': resolve(desktopNodeModules, 'react-dom'),
      '@bitsentry-ce/desktop-cli': resolve(__dirname, '../../packages/desktop-cli/src'),
      '@bitsentry-ce/coding-agents': resolve(__dirname, '../../packages/coding-agents/src'),
      '@bitsentry-ce/components': resolve(__dirname, '../../packages/components/src'),
      '@bitsentry-ce/core': resolve(__dirname, '../../packages/core/src'),
      '@bitsentry-ce/i18n': resolve(__dirname, '../../packages/i18n/src/index.ts'),
      'electron-trpc/renderer': resolve(
        __dirname,
        '../../packages/electron-trpc/packages/electron-trpc/src/renderer/index.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    setupFiles: ['src/__tests__/setup.ts'],
  },
})
