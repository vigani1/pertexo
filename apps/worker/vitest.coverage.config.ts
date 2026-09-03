import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pertexo/queue': fileURLToPath(
        new URL('../../packages/queue/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/worker',
      include: [
        'src/execution/{failure-notification-delivery,node-attempt-handler,node-runtime-capabilities,preview-attempt-runtime}.ts',
      ],
      // These gates establish the measured critical-runtime baseline. Raising
      // them requires tests for additional failure branches; integration-only
      // provider and persistence behavior remains covered by real services.
      thresholds: {
        branches: 93.1,
        functions: 80,
        lines: 93.2,
        statements: 93.1,
      },
    },
  },
});
