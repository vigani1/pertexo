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
        'src/{advance-workflow,checkpoint,node-attempt-input,operations,retries,transitions,workflow-transition-observations,workflow-transition-state}.ts',
      ],
      // Interface-level baseline after removing tests that directly mutated
      // private transition state. Future changes ratchet these values upward.
      thresholds: {
        branches: 91,
        functions: 93.5,
        lines: 94.9,
        statements: 94.4,
      },
    },
  },
});
