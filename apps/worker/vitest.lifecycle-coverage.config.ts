import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/worker-lifecycle',
      include: [
        'src/execution/{coordinator-runtime,failure-notification-handler,preview-attempt-handler,preview-maintenance-runtime}.ts',
        'src/runtime/background-task-deadline.ts',
      ],
      thresholds: {
        branches: 63,
        functions: 91,
        lines: 78,
        statements: 78,
        'src/execution/coordinator-runtime.ts': {
          branches: 71,
          functions: 88,
          lines: 84,
          statements: 83,
        },
        'src/execution/failure-notification-handler.ts': {
          branches: 70,
          functions: 100,
          lines: 100,
          statements: 95,
        },
        'src/execution/preview-attempt-handler.ts': {
          branches: 69,
          functions: 100,
          lines: 88,
          statements: 89,
        },
        'src/execution/preview-maintenance-runtime.ts': {
          branches: 46,
          functions: 83,
          lines: 55,
          statements: 56,
        },
        'src/runtime/background-task-deadline.ts': {
          branches: 100,
          functions: 83,
          lines: 81,
          statements: 81,
        },
      },
    },
  },
});
