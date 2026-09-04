import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/node-sdk',
      include: ['src/**/*.ts'],
      thresholds: { branches: 76, functions: 95, lines: 89, statements: 88 },
    },
  },
});
