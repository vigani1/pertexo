import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

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
    // The recursive workspace gate runs several suites concurrently. Bound
    // worker-test forks so compiled lifecycle children can start on time.
    maxWorkers: 4,
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
  },
});
