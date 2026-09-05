import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/contracts',
      include: ['src/**/*.ts'],
      thresholds: { branches: 71, functions: 91, lines: 95, statements: 95 },
    },
  },
});
