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
      thresholds: { branches: 80, functions: 100, lines: 96, statements: 96 },
    },
  },
});
