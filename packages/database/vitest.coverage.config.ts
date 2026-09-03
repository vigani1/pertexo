import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/database',
      // Persistence SQL paths are proven by real-service suites. This unit
      // gate covers the security-critical shared transaction engine.
      include: ['src/tenant-access/workspace.ts'],
      // Public testing-entrypoint baseline after removing assertions against
      // sibling-private coordinator/node-attempt transaction wrappers.
      thresholds: {
        branches: 95.3,
        functions: 100,
        lines: 97.9,
        statements: 96.3,
      },
    },
  },
});
