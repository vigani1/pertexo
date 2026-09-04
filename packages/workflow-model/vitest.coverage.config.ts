import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/workflow-model',
      include: ['src/**/*.ts'],
      thresholds: { branches: 78, functions: 94, lines: 89, statements: 86 },
    },
  },
});
