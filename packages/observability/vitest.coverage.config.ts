import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/observability',
      include: ['src/**/*.ts'],
      thresholds: { branches: 85, functions: 83, lines: 90, statements: 89 },
    },
  },
});
