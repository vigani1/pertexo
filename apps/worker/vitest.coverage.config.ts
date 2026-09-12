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
        'src/execution/{failure-notification-delivery,node-artifact-policy,node-attempt-execution-environment,node-attempt-handler,node-attempt-handler-state-error,node-execution-runtime-fields,node-runtime-capabilities,preview-attempt-runtime,provider-connection-runtime}.ts',
        'src/runtime/{worker-process-shutdown,worker-readiness-monitor,worker-readiness}.ts',
        'src/transport/node-attempt-runtime-provider.ts',
      ],
      // These gates establish the measured critical-runtime baseline. Raising
      // them requires tests for additional failure branches; integration-only
      // provider and persistence behavior remains covered by real services.
      thresholds: {
        branches: 93.1,
        functions: 80,
        lines: 93.2,
        statements: 93.1,
        'src/transport/node-attempt-runtime-provider.ts': {
          branches: 84,
          functions: 100,
          lines: 95,
          statements: 95,
        },
      },
    },
  },
});
