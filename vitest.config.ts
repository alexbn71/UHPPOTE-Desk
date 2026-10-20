import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/**/test/**/*.test.ts',
            'apps/server/test/unit/**/*.test.ts',
            'tools/**/test/**/*.test.ts',
            'homeassistant-addon/test/**/*.test.mjs',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/**/test/**/*.int.ts',
            'apps/server/test/integration/**/*.int.ts',
            'tools/**/test/**/*.int.ts',
          ],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
})
