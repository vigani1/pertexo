import { describe, expect, it } from 'vitest';

import { checkpoint, occurredAt } from '../../support/advance-workflow.js';
import { joinKey, advanceWorkflow } from '../../support/transition/advance.js';

describe('AdvanceWorkflow transitions', () => {
  it('marks a mixed succeeded and waiting run as waiting', () => {
    const running = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 2,
      observations: [
        { kind: 'ready', invocationKey: 'done', nodeId: 'done' },
        { kind: 'ready', invocationKey: 'wait', nodeId: 'wait' },
      ],
    });
    const waiting = advanceWorkflow({
      checkpoint: running.checkpoint,
      occurredAt,
      maximumAdmissions: 0,
      observations: [
        { kind: 'outcome', invocationKey: 'done', status: 'succeeded' },
        {
          kind: 'wait',
          waitKind: 'node_wait',
          invocationKey: 'wait',
          resumeAt: '2026-08-21T10:00:00.000Z',
        },
      ],
    });

    expect(waiting.checkpoint.runStatus).toBe('waiting');
  });
  it('settles joins and persists canonical selection through advancement', () => {
    const settled = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'join_declared',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          policy: { kind: 'any' },
          branchIds: ['b', 'a'],
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          branch: { branchId: 'b', disposition: 'arrived' },
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          branch: { branchId: 'a', disposition: 'arrived' },
        },
      ],
    });

    expect(settled.checkpoint.joins).toEqual([
      expect.objectContaining({
        joinId: 'join',
        policy: { kind: 'any' },
        ledger: [
          { branchId: 'a', disposition: 'arrived' },
          { branchId: 'b', disposition: 'arrived' },
        ],
        selectedBranchIds: ['a'],
      }),
    ]);
    expect(settled.attempts).toEqual([
      expect.objectContaining({ nodeId: 'join', attemptNumber: 1 }),
    ]);
    const duplicate = advanceWorkflow({
      checkpoint: settled.checkpoint,
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'branch_disposition',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          branch: { branchId: 'b', disposition: 'arrived' },
        },
      ],
    });
    expect(duplicate.checkpoint.joins[0]?.selectedBranchIds).toEqual(['a']);
    expect(duplicate.attempts).toEqual([]);
  });
  it('persists an unsatisfied join as a typed terminal failure', () => {
    const failed = advanceWorkflow({
      checkpoint: checkpoint(),
      occurredAt,
      maximumAdmissions: 1,
      observations: [
        {
          kind: 'join_declared',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          policy: { kind: 'count', count: 2 },
          branchIds: ['a', 'b'],
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          branch: { branchId: 'a', disposition: 'arrived' },
        },
        {
          kind: 'branch_disposition',
          joinId: 'join',
          joinInvocationKey: joinKey('join'),
          branch: { branchId: 'b', disposition: 'missing' },
        },
      ],
    });

    expect(failed.attempts).toEqual([]);
    expect(failed.checkpoint.joins[0]).toMatchObject({
      unsatisfiedReasonCode: 'insufficient_arrivals',
    });
    expect(failed.checkpoint.runStatus).toBe('failed');
  });
});
