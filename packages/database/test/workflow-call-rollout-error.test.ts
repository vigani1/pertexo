import { describe, expect, it } from 'vitest';
import {
  WorkflowCallsUnavailableError,
  mapWorkflowCallRolloutError,
} from '../src/execution/workflow-calls/workflow-call-rollout-error.js';

describe('Call rollout failure mapping', () => {
  it('maps only the registered flag refusal, including an ordinary query cause', () => {
    const refusal = Object.assign(new Error('workflow Calls are not enabled'), {
      code: '55000',
    });
    expect(
      mapWorkflowCallRolloutError(
        new Error('Query failed', { cause: refusal }),
      ),
    ).toBeInstanceOf(WorkflowCallsUnavailableError);
    const other = Object.assign(new Error('native owner differs'), {
      code: '55000',
    });
    expect(mapWorkflowCallRolloutError(other)).toBe(other);
  });
  it('preserves unrelated, malformed and cyclic failures', () => {
    const cycle = new Error('Cycle');
    cycle.cause = cycle;
    expect(mapWorkflowCallRolloutError(cycle)).toBe(cycle);
    const plain = { code: '55000', message: 'workflow Calls are not enabled' };
    expect(mapWorkflowCallRolloutError(plain)).toBe(plain);
  });
});
