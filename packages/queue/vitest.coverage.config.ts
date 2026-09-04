import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/queue',
      include: ['src/**/*.ts'],
      thresholds: { branches: 68, functions: 80, lines: 78, statements: 77 },
    },
  },
});
