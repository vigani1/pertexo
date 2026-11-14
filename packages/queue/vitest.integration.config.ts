import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Refuses to start without an explicit test stack (never the dev one).
    globalSetup: [
      fileURLToPath(
        new URL(
          '../../infrastructure/testing/redis-stack-setup.mjs',
          import.meta.url,
        ),
      ),
    ],
    include: ['test/**/*.integration.test.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
});
