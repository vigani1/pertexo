import { describe, expect, it } from 'vitest';

import { advanceWorkflowFromSchedulerState } from '../src/advance-workflow.js';
import { createCheckpoint } from '../src/index.js';

const occurredAt = '2026-08-20T10:00:00.000Z';

function input() {
  return {
    checkpoint: createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: 'version-1',
      iterationBudget: 100,
    }),
    schedulerState: { deriveReadiness: false, nodes: [], edges: [] } as const,
    occurredAt,
    maximumAdmissions: 0,
  };
}

describe('workflow advance risk branches', () => {
  it.each([-1, 0.5])(
    'rejects invalid maximum admissions %s',
    (maximumAdmissions) => {
      expect(() =>
        advanceWorkflowFromSchedulerState({ ...input(), maximumAdmissions }),
      ).toThrow(expect.objectContaining({ code: 'checkpoint_invalid' }));
    },
  );

  it('rejects a persisted cursor from another checkpoint position', () => {
    expect(() =>
      advanceWorkflowFromSchedulerState({
        ...input(),
        persistedObservationCursor: {
          expectedNextEventSequence: 3,
          consumedThroughEventSequence: 2,
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
  });

  it.each([
    { expectedNextEventSequence: 2, consumedThroughEventSequence: 0 },
    { expectedNextEventSequence: 2, consumedThroughEventSequence: 2 },
  ])(
    'rejects an inconsistent persisted cursor %#',
    (persistedObservationCursor) => {
      expect(() =>
        advanceWorkflowFromSchedulerState({
          ...input(),
          observations: [],
          persistedObservationCursor,
        }),
      ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
    },
  );

  it('accepts an empty persisted observation window without an observations field', () => {
    expect(
      advanceWorkflowFromSchedulerState({
        ...input(),
        persistedObservationCursor: {
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
        },
      }).checkpoint.runStatus,
    ).toBe('running');
  });
});
