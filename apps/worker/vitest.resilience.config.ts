import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    fileParallelism: false,
    hookTimeout: 120_000,
    include: ['test/**/*.resilience.integration.test.ts'],
    maxWorkers: 1,
    testTimeout: 240_000,
  },
});
