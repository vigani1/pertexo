import { describe, expect, it } from 'vitest';
import { advanceWorkflow } from '../../../src/index.js';

import { startForEach } from '../../support/compilation/for-each.js';

describe('For Each production operations', () => {
  it('retains running body truth across cancellation and deadline stops', async () => {
    const { base, control, declared, firstRoot } = await startForEach();

    const canceledBetweenBatches = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'cancel_requested',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
        },
      ],
      completedOutputs: [],
    });
    expect(canceledBetweenBatches.attempts).toEqual([]);
    expect(canceledBetweenBatches.checkpoint.loops[0]).toMatchObject({
      nextOrdinal: 1,
      activeOrdinals: [0],
      terminalOrdinals: [],
    });
    expect(canceledBetweenBatches.checkpoint.cancelRequested).toBe(true);
    expect(canceledBetweenBatches.checkpoint.runStatus).toBe('running');
    expect(
      canceledBetweenBatches.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === firstRoot.invocationKey,
      ),
    ).toMatchObject({ status: 'running' });
    const replayedCancellation = await advanceWorkflow({
      ...base,
      checkpoint: canceledBetweenBatches.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(replayedCancellation.checkpoint.loops).toEqual(
      canceledBetweenBatches.checkpoint.loops,
    );
    expect(replayedCancellation.attempts).toEqual([]);
    const reconciledCancellation = await advanceWorkflow({
      ...base,
      checkpoint: replayedCancellation.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: replayedCancellation.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000120',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000120',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: replayedCancellation.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000120',
          invocationKey: firstRoot.invocationKey,
          value: { value: 'late-success' },
        },
      ],
    });
    expect(reconciledCancellation.attempts).toEqual([]);
    expect(reconciledCancellation.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      completedPrefix: 1,
      terminalOrdinals: [],
      terminalStatus: 'canceled',
    });
    expect(reconciledCancellation.checkpoint.runStatus).toBe('canceled');
    const uncertainCancellation = await advanceWorkflow({
      ...base,
      checkpoint: replayedCancellation.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: replayedCancellation.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000122',
          attemptNumber: 1,
          status: 'outcome_unknown',
          reasonCode: 'provider_result_unknown',
        },
      ],
      completedOutputs: [],
    });
    expect(uncertainCancellation.attempts).toEqual([]);
    expect(uncertainCancellation.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      completedPrefix: 1,
      terminalOrdinals: [],
      terminalStatus: 'outcome_unknown',
    });
    expect(uncertainCancellation.checkpoint.runStatus).toBe('outcome_unknown');

    const expiredActiveLoop = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
      ],
      completedOutputs: [],
    });
    expect(expiredActiveLoop.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [],
    });
    expect(expiredActiveLoop.checkpoint.runStatus).toBe('running');
    expect(
      expiredActiveLoop.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === control.invocationKey,
      ),
    ).toMatchObject({ status: 'waiting' });
    const replayedDeadline = await advanceWorkflow({
      ...base,
      checkpoint: expiredActiveLoop.checkpoint,
      observations: [],
      completedOutputs: [],
    });
    expect(replayedDeadline.checkpoint.loops).toEqual(
      expiredActiveLoop.checkpoint.loops,
    );
    expect(replayedDeadline.attempts).toEqual([]);
    expect(
      expiredActiveLoop.checkpoint.invocations.find(
        ({ invocationKey }) => invocationKey === firstRoot.invocationKey,
      ),
    ).toMatchObject({ status: 'running' });
    const reconciledDeadline = await advanceWorkflow({
      ...base,
      checkpoint: replayedDeadline.checkpoint,
      observations: [
        {
          kind: 'outcome',
          sequence: replayedDeadline.checkpoint.nextEventSequence,
          occurredAt: base.occurredAt,
          invocationKey: firstRoot.invocationKey,
          attemptId: '00000000-0000-4000-8000-000000000121',
          attemptNumber: 1,
          status: 'succeeded',
          output: {
            kind: 'inline',
            attemptId: '00000000-0000-4000-8000-000000000121',
          },
        },
      ],
      completedOutputs: [
        {
          sequence: replayedDeadline.checkpoint.nextEventSequence,
          attemptId: '00000000-0000-4000-8000-000000000121',
          invocationKey: firstRoot.invocationKey,
          value: { value: 'late-success' },
        },
      ],
    });
    expect(reconciledDeadline.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [],
      completedPrefix: 1,
      terminalOrdinals: [],
      terminalStatus: 'timed_out',
    });
    expect(reconciledDeadline.checkpoint.runStatus).toBe('timed_out');

    const canceledDeadline = await advanceWorkflow({
      ...base,
      checkpoint: declared.checkpoint,
      observations: [
        {
          kind: 'deadline_expired',
          occurredAt: '2026-08-24T10:01:00.000Z',
        },
        {
          kind: 'cancel_requested',
          sequence: declared.checkpoint.nextEventSequence,
          occurredAt: '2026-08-24T10:00:30.000Z',
        },
      ],
      completedOutputs: [],
    });
    expect(canceledDeadline.checkpoint.loops[0]).toMatchObject({
      activeOrdinals: [0],
      terminalOrdinals: [],
    });
    expect(canceledDeadline.checkpoint.runStatus).toBe('running');
  });
});
