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
    // Real-time waits too long for the integration lane: Redis outages under
    // the event stream, and a proposal waiting out its whole deadline.
    include: ['test/**/*.resilience.integration.test.ts'],
    maxWorkers: 1,
    testTimeout: 240_000,
  },
});
