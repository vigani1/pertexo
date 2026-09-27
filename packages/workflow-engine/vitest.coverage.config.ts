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
        'src/{transition/advance-workflow,checkpoint/checkpoint,checkpoint/checkpoint-executable-validation,checkpoint/checkpoint-shared,checkpoint/checkpoint-v1,checkpoint/checkpoint-v1-join,checkpoint/checkpoint-v1-loop,checkpoint/checkpoint-v2,observation/coordinator-failures,observation/coordinator-loop-observations,observation/coordinator-observations,observation/coordinator-output,compilation/executable-compatibility,compilation/executable-graph,compilation/executable-graph-boundary,compilation/executable-graph-rules,compilation/executable-validation,transition/graph-scheduler,attempt/node-attempt-input,operations,output-reference,observation/persisted-observation-parser,observation/persisted-observations,attempt/retries,transition/scheduling,transition/transition-decisions,transition/transitions,transition/workflow-transition-derived,transition/workflow-transition-loops,transition/workflow-transition-observations,transition/workflow-transition-plan,transition/workflow-transition-state,transition/workflow-transition-stops}.ts',
        'src/{checkpoint/checkpoint-identity,core-definition-identities,errors,compilation/executable-boundary,compilation/executable-compilation,compilation/executable-foundation,compilation/executable-graph-validation-index,compilation/executable-identity,transition/graph-scheduler-indexes,operation-values,ordering,scope,server-only,testing-graph,testing,types}.ts',
      ],
      thresholds: {
        branches: 85,
        functions: 93,
        lines: 91,
        statements: 90,
        // Preserve the stronger pre-expansion ratchet for its original cohort.
        'src/{transition/advance-workflow,checkpoint/checkpoint,checkpoint/checkpoint-executable-validation,checkpoint/checkpoint-shared,checkpoint/checkpoint-v1,checkpoint/checkpoint-v1-join,checkpoint/checkpoint-v1-loop,checkpoint/checkpoint-v2,compilation/executable-graph,attempt/node-attempt-input,operations,output-reference,attempt/retries,transition/transitions,transition/workflow-transition-loops,transition/workflow-transition-observations,transition/workflow-transition-state}.ts':
          {
            branches: 91,
            functions: 93.5,
            lines: 94.9,
            statements: 94.4,
          },
        'src/observation/coordinator-observations.ts': { branches: 82 },
        'src/observation/coordinator-loop-observations.ts': { branches: 82 },
        'src/compilation/executable-compatibility.ts': { branches: 75 },
        'src/compilation/executable-graph-boundary.ts': { branches: 87 },
        'src/compilation/executable-graph-rules.ts': {
          branches: 82,
          functions: 100,
          lines: 90,
          statements: 88,
        },
        'src/compilation/executable-validation.ts': { branches: 70 },
        'src/transition/graph-scheduler.ts': { branches: 81 },
        'src/observation/persisted-observation-parser.ts': { branches: 85 },
        'src/observation/persisted-observations.ts': { branches: 63 },
        'src/transition/scheduling.ts': { branches: 88 },
        'src/transition/transition-decisions.ts': {
          branches: 92,
          functions: 91,
          lines: 95,
          statements: 95,
        },
        'src/transition/workflow-transition-derived.ts': { branches: 81 },
        'src/transition/workflow-transition-plan.ts': { branches: 94 },
        'src/transition/workflow-transition-stops.ts': { branches: 82 },
      },
    },
  },
});
