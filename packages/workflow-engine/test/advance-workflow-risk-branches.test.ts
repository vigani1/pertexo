import { describe, expect, it } from 'vitest';

import { advanceWorkflow, createCheckpoint } from '../src/testing.js';

const occurredAt = '2026-08-20T10:00:00.000Z';

function input() {
  return {
    checkpoint: createCheckpoint({
      engineVersion: 'engine-v1',
      workflowVersionId: '00000000-0000-4000-8000-000000000001',
      iterationBudget: 100,
    }),
    schedulerState: { deriveReadiness: false, nodes: [], edges: [] } as const,
    occurredAt,
    maximumAdmissions: 0,
  };
}

describe('workflow advance public risk behavior', () => {
  it.each([-1, 0.5])(
    'rejects invalid maximum admissions %s',
    (maximumAdmissions) => {
      expect(() => advanceWorkflow({ ...input(), maximumAdmissions })).toThrow(
        expect.objectContaining({ code: 'checkpoint_invalid' }),
      );
    },
  );

  it('rejects a persisted cursor from another checkpoint position', () => {
    expect(() =>
      advanceWorkflow({
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
  ])('rejects an inconsistent persisted cursor %#', (cursor) => {
    expect(() =>
      advanceWorkflow({
        ...input(),
        observations: [],
        persistedObservationCursor: cursor,
      }),
    ).toThrow(expect.objectContaining({ code: 'observation_invalid' }));
  });

  it('accepts an empty durable observation window', () => {
    expect(
      advanceWorkflow({
        ...input(),
        persistedObservationCursor: {
          expectedNextEventSequence: 2,
          consumedThroughEventSequence: 1,
        },
      }).checkpoint.runStatus,
    ).toBe('running');
  });
});
