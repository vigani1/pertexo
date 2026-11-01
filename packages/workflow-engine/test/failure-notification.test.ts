import { expect, it } from 'vitest';
import { notificationFailures } from '../src/completion/failure-notification.js';
import { createCheckpoint } from '../src/index.js';

it('selects uncertainty before timeout before failure with stable invocation ordering', () => {
  const checkpoint = {
    ...createCheckpoint({
      workflowVersionId: '33333333-3333-4333-8333-333333333333',
      iterationBudget: 10,
      nextEventSequence: 1,
    }),
    invocations: [
      {
        nodeId: 'f',
        invocationKey: 'f',
        status: 'failed' as const,
        attemptNumber: 1,
      },
      {
        nodeId: 't',
        invocationKey: 't',
        status: 'timed_out' as const,
        attemptNumber: 1,
      },
      {
        nodeId: 'b',
        invocationKey: 'b',
        status: 'outcome_unknown' as const,
        attemptNumber: 1,
      },
      {
        nodeId: 'a',
        invocationKey: 'a',
        status: 'outcome_unknown' as const,
        attemptNumber: 1,
      },
      {
        nodeId: 's',
        invocationKey: 's',
        status: 'succeeded' as const,
        attemptNumber: 1,
      },
    ],
  };
  expect(notificationFailures(checkpoint).map(({ nodeId }) => nodeId)).toEqual([
    'a',
    'b',
    't',
    'f',
  ]);
  expect(checkpoint.invocations.map(({ nodeId }) => nodeId)).toEqual([
    'f',
    't',
    'b',
    'a',
    's',
  ]);
});

it('excludes handled failures when identifying and counting failures', () => {
  const checkpoint = {
    ...createCheckpoint({
      workflowVersionId: '33333333-3333-4333-8333-333333333333',
      iterationBudget: 10,
      nextEventSequence: 1,
    }),
    invocations: [
      {
        nodeId: 'a-handled',
        invocationKey: 'a-handled',
        status: 'failed' as const,
        attemptNumber: 1,
        failureHandling: {
          sinkInvocationKey: 'handler',
          disposition: 'handled' as const,
        },
      },
      {
        nodeId: 'z-failed',
        invocationKey: 'z-failed',
        status: 'failed' as const,
        attemptNumber: 1,
      },
    ],
  };
  const failures = notificationFailures(checkpoint);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.nodeId).toBe('z-failed');
});
