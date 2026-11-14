import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    // Refuses to start without an explicit test stack (never the dev one).
    globalSetup: [
      fileURLToPath(
        new URL(
          '../../infrastructure/testing/test-stack-setup.mjs',
          import.meta.url,
        ),
      ),
    ],
    fileParallelism: false,
    hookTimeout: 120_000,
    include: [
      'test/workflow-runs/events/stream.resilience.integration.test.ts',
    ],
    maxWorkers: 1,
    testTimeout: 240_000,
  },
});
