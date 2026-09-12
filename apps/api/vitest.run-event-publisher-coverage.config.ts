import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  resolve: {
    alias: {
      '@pertexo/queue': resolve(
        import.meta.dirname,
        '../../packages/queue/src/index.ts',
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/api/test/executions/redis-run-event-publisher.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage/api-run-event-publisher',
      include: ['packages/queue/src/run-event-notifications.ts'],
      thresholds: {
        branches: 81,
        functions: 100,
        lines: 98,
        statements: 98,
      },
    },
  },
});
