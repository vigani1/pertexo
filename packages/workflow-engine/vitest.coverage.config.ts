import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: '../../coverage/workflow-engine',
      include: [
        'src/{advance-workflow,checkpoint,operations,transitions,workflow-transition-observations,workflow-transition-state}.ts',
      ],
      thresholds: {
        branches: 79,
        functions: 85,
        lines: 85,
        statements: 85,
      },
    },
  },
});
