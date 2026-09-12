import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: [
      'dist/**',
      'node_modules/**',
      'test/**/*.integration.test.ts',
      'test/executions/redis-run-event-publisher.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/api-priority',
      include: [
        'src/app.ts',
        'src/identity/{csrf,oidc,session}.ts',
        'src/identity-infrastructure/{oidc-adapter,oidc-request-validation,oidc-response-cleanup,oidc-secret-encryption}.ts',
        'src/identity-workspace/{module,use-cases}.ts',
        'src/platform/identity/identity-runtime.module.ts',
        'src/webhooks/ingress.ts',
        'src/workflow-authoring/{lifecycle-use-case,module,preconditions,restore-version-use-case,use-cases}.ts',
      ],
      thresholds: {
        branches: 82,
        functions: 96,
        lines: 92,
        statements: 91,
        'src/webhooks/ingress.ts': {
          branches: 86,
          functions: 91,
          lines: 88,
          statements: 87,
        },
      },
    },
  },
});
