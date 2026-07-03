import { resolve } from 'path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@bitsentry-ce/coding-agents': resolve(__dirname, '../coding-agents/src'),
      '@bitsentry-ce/core': resolve(__dirname, '../core/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
