import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: '../../coverage/database',
      // Persistence SQL paths are proven by real-service suites. This unit
      // gate covers the security-critical shared transaction engine.
      include: ['src/workspace.ts'],
      thresholds: {
        branches: 60,
        functions: 75,
        lines: 85,
        statements: 79,
      },
    },
  },
});
