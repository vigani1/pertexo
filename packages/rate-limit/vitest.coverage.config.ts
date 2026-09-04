import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/rate-limit',
      include: ['src/**/*.ts'],
      thresholds: {
        branches: 86,
        functions: 92,
        lines: 90,
        statements: 90,
      },
    },
  },
});
