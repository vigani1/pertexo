import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/node-catalog',
      include: ['src/{definition-resolution,registry,server}.ts'],
      thresholds: {
        branches: 81,
        functions: 100,
        lines: 86,
        statements: 86,
      },
    },
  },
});
