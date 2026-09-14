import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/main.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/recovery-entrypoints',
      include: ['src/main.ts'],
      // The subprocess suite owns the real main-guard callback; strict branch
      // review below the percentage gate remains in the root risk report.
      thresholds: { branches: 65, functions: 65, lines: 80, statements: 80 },
    },
  },
});
