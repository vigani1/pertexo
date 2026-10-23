import { describe, expect, it } from 'vitest';
import { advanceWorkflow } from '../../../src/index.js';

import { startForEach } from '../../support/compilation/for-each.js';

describe('For Each production operations', () => {
  it('retries and terminalizes failed body work', async () => {
    const { base, control, declared, firstRoot } = await startForEach();

    const retryingBody = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000110',
          attemptNumber: 1,
          failureKind: 'retry',
          errorKind: 'network',
          possiblyDispatched: false,
          safeErrorCode: 'body.retry',
        },
      ],
      completedOutputs: [],
    });
    expect(
      retryingBody.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === firstRoot.invocationKey,
      ),
    ).toMatchObject({ status: 'waiting', attemptNumber: 1 });
    expect(retryingBody.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [],
    });

    const finalBodyFailure = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'attempt_failure',
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000111',
          attemptNumber: 1,
          failureKind: 'failed',
          errorKind: 'provider',
          possiblyDispatched: false,
          safeErrorCode: 'body.failed',
        },
      ],
      completedOutputs: [],
    });
    expect(finalBodyFailure.attempts).toEqual([]);
    expect(finalBodyFailure.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      terminalStatus: 'failed',
    });
    expect(
      finalBodyFailure.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'failed' });

    const failedBody = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000107',
          attemptNumber: 1,
          status: 'failed',
          reasonCode: 'body_failed',
        },
      ],
      completedOutputs: [],
    });
    expect(failedBody.attempts).toEqual([]);
    expect(failedBody.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      terminalStatus: 'failed',
    });
    expect(
      failedBody.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'failed',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000102',
      },
    });
  });
  it('enforces loop budgets and preserves empty or artifact declarations', async () => {
    const { afterManual, base, control } = await startForEach();

    const limitedCheckpoint = structuredClone(afterManual.checkpoint);
    Object.assign(limitedCheckpoint, {
      initialIterationBudget: 1,
      remainingIterationBudget: 1,
    });
    const limited = await advanceWorkflow({
      ...base,
      checkpoint: limitedCheckpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: limitedCheckpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000103',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000103',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: limitedCheckpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000103',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(limited.checkpoint.remainingIterationBudget).toBe(1);
    expect(limited.checkpoint.loops).toEqual([]);
    expect(limited.attempts).toEqual([]);
    expect(limited.events).toContainEqual(
      expect.objectContaining({
        name: 'node.failed',
        nodeId: 'loop',
        reasonCode: 'loop_limit_exceeded',
      }),
    );

    const empty = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000106',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000106',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000106',
          invocationKey: control.invocationKey,
          value: { items: [], iterationCount: 0 },
        },
      ],
    });
    expect(empty.attempts).toEqual([]);
    expect(
      empty.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'succeeded',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000106',
      },
    });

    const artifactDeclaration = await advanceWorkflow({
      ...base,
      checkpoint: afterManual.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000108',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'artifact',
            artifactId: '00000000-0000-4000-8000-000000000109',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000108',
          invocationKey: control.invocationKey,
          value: { items: [], iterationCount: 0 },
        },
      ],
    });
    expect(artifactDeclaration.checkpoint.loops[0]?.collection).toEqual({
      kind: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000109',
    });
  });
});
