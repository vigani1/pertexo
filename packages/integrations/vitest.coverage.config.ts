import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/integrations',
      include: ['src/**/*.ts'],
      thresholds: { branches: 73, functions: 90, lines: 85, statements: 84 },
    },
  },
});
