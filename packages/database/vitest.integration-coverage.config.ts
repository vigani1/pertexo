import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/database-integration',
      thresholds: {
        branches: 70.8,
        functions: 85.1,
        lines: 81.6,
        statements: 79.6,
      },
    },
  },
});
