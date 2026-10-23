import { describe, expect, it } from 'vitest';
import { advanceWorkflow } from '../../../src/index.js';

import { startForEach } from '../../support/compilation/for-each.js';

describe('For Each production operations', () => {
  it('declares and replays stable scoped ordinals', async () => {
    const { afterManual, base, control, declared } = await startForEach();
    expect(declared.checkpoint.remainingIterationBudget).toBe(0);
    expect(
      declared.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({
      status: 'waiting',
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000102',
      },
    });
    expect(declared.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-first',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      }),
    ]);
    expect(typeof declared.attempts[0]?.providerIdempotencyKey).toBe('string');
    expect(declared.checkpoint.loops[0]).toMatchObject({
      controlInvocationKey: control.invocationKey,
      activeOrdinals: [0],
      nextOrdinal: 1,
      terminalOrdinals: [],
    });
    const replayedDeclaration = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterManual.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: control.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000102',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000102',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterManual.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000102',
          invocationKey: control.invocationKey,
          value: { items: ['first', 'second'], iterationCount: 2 },
        },
      ],
    });
    expect(replayedDeclaration.checkpoint.remainingIterationBudget).toBe(0);
    expect(replayedDeclaration.checkpoint.loops).toEqual(
      declared.checkpoint.loops,
    );
    await expect(
      advanceWorkflow({
        ...base,
        checkpoint: afterManual.checkpoint,
        observations: [
          {
            kind: 'outcome',
            sequence: afterManual.checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: control.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000102',
            attemptNumber: 1,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000102',
            },
          },
        ],
        completedOutputs: [
          {
            sequence: afterManual.checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000102',
            invocationKey: control.invocationKey,
            value: { items: ['first', 'second'], iterationCount: 2 },
          },
          {
            sequence: afterManual.checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000102',
            invocationKey: control.invocationKey,
            value: { items: ['changed'], iterationCount: 1 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'observation_invalid' });
  });
  it('advances one body ordinal sequentially', async () => {
    const { base, declared, firstRoot } = await startForEach();
    const afterRoot = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000104',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000104',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: declared.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000104',
          invocationKey: firstRoot.invocationKey,
          value: { value: 'first' },
        },
      ],
    });
    expect(afterRoot.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-sink',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
      }),
    ]);
    const firstSink = afterRoot.attempts[0];
    if (firstSink === undefined) throw new Error('first body sink missing');
    const nextOrdinal = await advanceWorkflow({
      ...base,
      checkpoint: afterRoot.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: afterRoot.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstSink.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000105',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000105',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: afterRoot.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000105',
          invocationKey: firstSink.invocationKey,
          value: { value: 'first' },
        },
      ],
    });
    expect(nextOrdinal.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [1],
      nextOrdinal: 2,
      completedPrefix: 1,
      terminalOrdinals: [],
    });
    expect(nextOrdinal.attempts).toEqual([
      expect.objectContaining({
        nodeId: 'body-first',
        iterationPath: [{ loopNodeId: 'loop', ordinal: 1 }],
      }),
    ]);
    for (const sequence of [
      afterRoot.checkpoint.nextEventSequence,
      nextOrdinal.checkpoint.nextEventSequence,
    ]) {
      await expect(
        advanceWorkflow({
          ...base,
          checkpoint: nextOrdinal.checkpoint,
          observations: [
            {
              kind: 'outcome',
              sequence,
              occurredAt: base.occurredAt,
              invocationKey: firstSink.invocationKey,
              attemptId: '00000000-0000-4000-8000-000000000105',
              attemptNumber: 1,
              status: 'succeeded',
              output: {
                kind: 'inline',
                attemptId: '00000000-0000-4000-8000-000000000105',
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'observation_invalid' });
    }
  });
});
