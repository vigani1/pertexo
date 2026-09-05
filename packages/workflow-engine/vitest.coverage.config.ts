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
        'src/{advance-workflow,checkpoint,checkpoint-shared,checkpoint-v1,checkpoint-v1-join,checkpoint-v1-loop,checkpoint-v2,coordinator-failures,coordinator-observations,coordinator-output,executable-compatibility,executable-graph-boundary,executable-validation,graph-scheduler,node-attempt-input,operations,persisted-observation-parser,persisted-observations,retries,scheduling,transitions,workflow-transition-derived,workflow-transition-observations,workflow-transition-plan,workflow-transition-state,workflow-transition-stops}.ts',
      ],
      thresholds: {
        branches: 85,
        functions: 93,
        lines: 91,
        statements: 90,
        // Preserve the stronger pre-expansion ratchet for its original cohort.
        'src/{advance-workflow,checkpoint,checkpoint-shared,checkpoint-v1,checkpoint-v1-join,checkpoint-v1-loop,checkpoint-v2,node-attempt-input,operations,retries,transitions,workflow-transition-observations,workflow-transition-state}.ts':
          {
            branches: 91,
            functions: 93.5,
            lines: 94.9,
            statements: 94.4,
          },
        'src/coordinator-observations.ts': { branches: 82 },
        'src/executable-compatibility.ts': { branches: 75 },
        'src/executable-graph-boundary.ts': { branches: 87 },
        'src/executable-validation.ts': { branches: 70 },
        'src/graph-scheduler.ts': { branches: 81 },
        'src/persisted-observation-parser.ts': { branches: 85 },
        'src/persisted-observations.ts': { branches: 63 },
        'src/scheduling.ts': { branches: 88 },
        'src/workflow-transition-derived.ts': { branches: 81 },
        'src/workflow-transition-plan.ts': { branches: 94 },
        'src/workflow-transition-stops.ts': { branches: 82 },
      },
    },
  },
});
