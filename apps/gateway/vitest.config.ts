import { defineConfig } from 'vitest/config'

// Unit tests only. Sandbox integration tests: `pnpm test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
  },
})
