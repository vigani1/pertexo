import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', 'test/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/api',
      include: [
        'src/identity/{crypto,csrf,session}.ts',
        'src/platform/http/{application-error,problem-details.filter,request-headers}.ts',
        'src/platform/rate-limit/{interceptor,metadata,metrics,rate-limit.module}.ts',
        'src/workspaces/{authorize-workspace,policy}.ts',
      ],
      thresholds: {
        branches: 84,
        functions: 95,
        lines: 91,
        statements: 90,
      },
    },
  },
});
