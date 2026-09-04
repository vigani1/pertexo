import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/artifact-store',
      include: ['src/**/*.ts'],
      thresholds: { branches: 82, functions: 91, lines: 90, statements: 88 },
    },
  },
});
