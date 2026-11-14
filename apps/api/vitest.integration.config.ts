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
    exclude: ['test/**/*.resilience.integration.test.ts'],
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
