import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/nodes-core',
      include: ['src/**/*.ts'],
      thresholds: { branches: 59, functions: 57, lines: 84, statements: 84 },
    },
  },
});
