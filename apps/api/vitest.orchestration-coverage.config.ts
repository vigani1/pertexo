import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', 'test/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/api-orchestration',
      include: [
        'src/application-error-mappers.ts',
        'src/connections/connection-testing.ts',
        'src/workflow-runs/{sse-authorization-lifetime,use-cases}.ts',
      ],
      thresholds: {
        branches: 92,
        functions: 95,
        lines: 95,
        statements: 94,
      },
    },
  },
});
