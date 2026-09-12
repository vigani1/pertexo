import { describe, expect, it } from 'vitest';

import config from '../vitest.coverage.config.js';

describe('@pertexo/workflow-engine coverage inventory', () => {
  it('measures every runtime module while preserving the original-cohort ratchet', () => {
    expect(config.test?.coverage?.include).toEqual([
      'src/{advance-workflow,checkpoint,checkpoint-executable-validation,checkpoint-shared,checkpoint-v1,checkpoint-v1-join,checkpoint-v1-loop,checkpoint-v2,coordinator-failures,coordinator-observations,coordinator-output,executable-compatibility,executable-graph,executable-graph-boundary,executable-graph-rules,executable-validation,graph-scheduler,node-attempt-input,operations,output-reference,persisted-observation-parser,persisted-observations,retries,scheduling,transition-decisions,transitions,workflow-transition-derived,workflow-transition-observations,workflow-transition-plan,workflow-transition-state,workflow-transition-stops}.ts',
      'src/{checkpoint-identity,core-definition-identities,errors,executable-boundary,executable-compilation,executable-foundation,executable-graph-validation-index,executable-identity,graph-scheduler-indexes,operation-values,ordering,runtime,scope,server-only,testing-graph,testing,types}.ts',
    ]);
    expect(config.test?.coverage?.thresholds).toMatchObject({
      branches: 85,
      functions: 93,
      lines: 91,
      statements: 90,
      'src/{advance-workflow,checkpoint,checkpoint-executable-validation,checkpoint-shared,checkpoint-v1,checkpoint-v1-join,checkpoint-v1-loop,checkpoint-v2,executable-graph,node-attempt-input,operations,output-reference,retries,transitions,workflow-transition-observations,workflow-transition-state}.ts':
        {
          branches: 91,
          functions: 93.5,
          lines: 94.9,
          statements: 94.4,
        },
    });
  });
});
