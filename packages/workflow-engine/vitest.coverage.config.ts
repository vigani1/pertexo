import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: '../../coverage/workflow-engine',
      include: [
        'src/{advance-workflow,checkpoint,node-attempt-input,operations,transitions,workflow-transition-observations,workflow-transition-state}.ts',
      ],
      thresholds: {
        branches: 79.3,
        functions: 90,
        lines: 88.5,
        statements: 87.5,
      },
    },
  },
});
