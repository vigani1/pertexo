import { describe, expect, it } from 'vitest';

import {
  parseCheckpoint,
  type WorkflowTransitionPlan,
} from '../../src/index.js';
import { at, fixture, key } from '../support/failure-routing/runtime.js';

// A waiting invocation carries its wait kind and due time; once it leaves
// waiting, neither may remain, and every checkpoint the engine writes must
// read back.
describe('invocation state across a retry wait', () => {
  it('keeps the wait fields only while the step waits', async () => {
    const run = fixture();
    await run.step();
    await run.success('manual');
    const waiting = await run.fail({
      failureKind: 'retry',
      errorKind: 'network',
    });
    const waitingSet = setInvocation(waiting);
    expect(waitingSet).toMatchObject({
      status: 'waiting',
      waitKind: 'retry_backoff',
      resumeAt: expect.any(String) as unknown,
    });
    expect(waitingSet).not.toHaveProperty('output');
    verifyReadsBack(waiting);

    const resumeAt = waitingSet.resumeAt ?? '';
    const resumed = await run.step(
      [{ kind: 'due_at', occurredAt: resumeAt, invocationKey: key('set') }],
      resumeAt,
    );
    expect(setInvocation(resumed)).toMatchObject({
      status: 'running',
      attemptNumber: 2,
    });
    expect(setInvocation(resumed)).not.toHaveProperty('resumeAt');
    expect(setInvocation(resumed)).not.toHaveProperty('waitKind');
    verifyReadsBack(resumed);

    const succeeded = await run.step(
      [
        {
          sequence: resumed.checkpoint.nextEventSequence,
          occurredAt: resumeAt,
          kind: 'outcome',
          invocationKey: key('set'),
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000003',
          },
          attemptId: '00000000-0000-4000-8000-000000000003',
          attemptNumber: 2,
        },
      ],
      resumeAt,
    );
    expect(setInvocation(succeeded)).toMatchObject({
      status: 'succeeded',
      output: { kind: 'inline' },
    });
    expect(setInvocation(succeeded)).not.toHaveProperty('resumeAt');
    expect(setInvocation(succeeded)).not.toHaveProperty('waitKind');
    verifyReadsBack(succeeded);
  });

  it('drops the wait fields when a waiting step is canceled', async () => {
    const run = fixture();
    await run.step();
    await run.success('manual');
    const waiting = await run.fail({
      failureKind: 'retry',
      errorKind: 'network',
    });
    const canceled = await run.step([
      {
        kind: 'cancel_requested',
        sequence: waiting.checkpoint.nextEventSequence,
        occurredAt: at,
      },
    ]);
    expect(canceled.checkpoint.runStatus).toBe('canceled');
    expect(setInvocation(canceled)).toMatchObject({ status: 'canceled' });
    expect(setInvocation(canceled)).not.toHaveProperty('resumeAt');
    expect(setInvocation(canceled)).not.toHaveProperty('waitKind');
    verifyReadsBack(canceled);
  });
});

function setInvocation(plan: WorkflowTransitionPlan) {
  const invocation = plan.checkpoint.invocations.find(
    ({ nodeId }) => nodeId === 'set',
  );
  if (invocation === undefined) throw new Error('The set step never started');
  return invocation;
}

function verifyReadsBack(plan: WorkflowTransitionPlan) {
  expect(parseCheckpoint(JSON.parse(JSON.stringify(plan.checkpoint)))).toEqual(
    plan.checkpoint,
  );
}
