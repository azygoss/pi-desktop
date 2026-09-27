import { defineConfig } from 'vitest/config'

// E2E config: Playwright Electron tests against the built app + fake pi.
// Run with `pnpm test:e2e` (builds first). Not part of `pnpm test`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 90_000,
    pool: 'forks',
    maxWorkers: 1,
    minWorkers: 1
  }
})
