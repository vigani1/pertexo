import { describe, expect, it } from 'vitest';

import config from '../vitest.coverage.config.js';

describe('@pertexo/workflow-engine coverage inventory', () => {
  it('measures every runtime module while preserving the original-cohort ratchet', () => {
    expect(config.test?.coverage?.include).toEqual([
      'src/{transition/advance-workflow,checkpoint/checkpoint,checkpoint/checkpoint-executable-validation,checkpoint/checkpoint-shared,checkpoint/checkpoint-v1,checkpoint/checkpoint-v1-join,checkpoint/checkpoint-v1-loop,checkpoint/checkpoint-v2,observation/coordinator-failures,observation/coordinator-loop-observations,observation/coordinator-observations,observation/coordinator-output,compilation/executable-compatibility,compilation/executable-graph,compilation/executable-graph-boundary,compilation/executable-graph-rules,compilation/executable-validation,transition/graph-scheduler,attempt/node-attempt-input,operations,output-reference,observation/persisted-observation-parser,observation/persisted-observations,attempt/retries,transition/scheduling,transition/transition-decisions,transition/transitions,transition/workflow-transition-derived,transition/workflow-transition-loops,transition/workflow-transition-observations,transition/workflow-transition-plan,transition/workflow-transition-state,transition/workflow-transition-stops}.ts',
      'src/{checkpoint/checkpoint-identity,core-definition-identities,errors,compilation/executable-boundary,compilation/executable-compilation,compilation/executable-foundation,compilation/executable-graph-validation-index,compilation/executable-identity,transition/graph-scheduler-indexes,operation-values,ordering,scope,server-only,testing-graph,testing,types}.ts',
    ]);
    expect(config.test?.coverage?.thresholds).toMatchObject({
      branches: 85,
      functions: 93,
      lines: 91,
      statements: 90,
      'src/{transition/advance-workflow,checkpoint/checkpoint,checkpoint/checkpoint-executable-validation,checkpoint/checkpoint-shared,checkpoint/checkpoint-v1,checkpoint/checkpoint-v1-join,checkpoint/checkpoint-v1-loop,checkpoint/checkpoint-v2,compilation/executable-graph,attempt/node-attempt-input,operations,output-reference,attempt/retries,transition/transitions,transition/workflow-transition-loops,transition/workflow-transition-observations,transition/workflow-transition-state}.ts':
        {
          branches: 91,
          functions: 93.5,
          lines: 94.9,
          statements: 94.4,
        },
    });
  });
});
