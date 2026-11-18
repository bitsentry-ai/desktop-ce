import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// Anything that needs real layout is named *.browser.test.{ts,tsx} and runs in headless Chromium, with the same
// compiler plugin and aliases as the unit tests, so it exercises the compiled components.
export default defineConfig({
  plugins: base.plugins,
  resolve: base.resolve,
  // Pre-bundled so the first test does not trigger a mid-run reload.
  optimizeDeps: { include: ['@legendapp/list/react', 'react-dom/client', '@testing-library/react'] },
  test: {
    name: 'browser',
    include: ['src/**/*.browser.test.{ts,tsx}'],
    css: true,
    hookTimeout: 15_000,
    testTimeout: 15_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
})
