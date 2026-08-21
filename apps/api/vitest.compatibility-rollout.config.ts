import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['test/platform/compatibility-rollout.integration.test.ts'],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
