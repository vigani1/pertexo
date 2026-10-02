import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTransaction } from '../src/tenant-access/workspace.js';
import { acceptWorkflowCallCandidate } from '../src/execution/workflow-calls/workflow-call-candidate.js';
import {
  WorkflowCallAdmissionRefusedError,
  WorkflowCallAdmissionStoppedError,
} from '../src/execution/workflow-calls/workflow-call-admission.js';

const mocks = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock('../src/execution/runs/execution-acceptance.js', () => ({
  acceptWorkflowRun: mocks.accept,
}));
const runId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const input = {
  operation: 'workflow.run.accept' as const,
  triggerType: 'workflow_call' as const,
  workflowId: runId,
  workflowVersionId: versionId,
  engineVersion: 'test-engine',
  initialCheckpoint: {},
  call: {
    parentRunId: runId,
    expectedParentRevision: 4,
    invocationKey: 'call/root',
  },
};
const accepted = {
  acceptedAt: new Date('2026-10-02T10:00:00Z'),
  duplicate: false,
  outboxEventId: versionId,
  runId,
  status: 'queued' as const,
};
function fixture() {
  const order: string[] = [];
  const execute = vi.fn((statement: SQL) => {
    order.push(new PgDialect().sqlToQuery(statement).sql);
    return Promise.resolve({ rows: [] });
  });
  const transaction = {
    workspaceId: runId,
    db: { execute },
  } as unknown as WorkspaceTransaction;
  mocks.accept.mockImplementation(() => {
    order.push('accept');
    return Promise.resolve(accepted);
  });
  return { transaction, execute, order };
}
beforeEach(() => vi.resetAllMocks());

describe('Workflow Call candidate savepoint boundary', () => {
  it('reuses the same transaction and releases accepted candidate writes without committing', async () => {
    const f = fixture();
    const outcome = await acceptWorkflowCallCandidate(f.transaction, input);
    expect(mocks.accept).toHaveBeenCalledWith(f.transaction, input);
    expect(f.order).toEqual([
      'savepoint workflow_call_candidate',
      'accept',
      'release savepoint workflow_call_candidate',
    ]);
    expect(outcome).toEqual({ kind: 'accepted', accepted });
    expect(Object.isFrozen(outcome)).toBe(true);
  });
  it.each([
    'workflow.child_capacity_unavailable',
    'workflow.child_queue_unavailable',
    'workflow.child_entitlement_unavailable',
    'workflow.child_authority_unavailable',
    'workflow.child_admission_unavailable',
    'workflow.child_compatibility_unavailable',
  ] as const)(
    'removes every candidate write before returning %s',
    async (reasonCode) => {
      const f = fixture();
      mocks.accept.mockRejectedValueOnce(
        new WorkflowCallAdmissionRefusedError(reasonCode),
      );
      const outcome = await acceptWorkflowCallCandidate(f.transaction, input);
      expect(outcome).toEqual({ kind: 'refused', reasonCode });
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(f.order).toEqual([
        'savepoint workflow_call_candidate',
        'rollback to savepoint workflow_call_candidate',
        'release savepoint workflow_call_candidate',
      ]);
    },
  );
  it.each(['cancel_requested', 'deadline_expired'] as const)(
    'returns %s separately from refusal after recovery',
    async (reason) => {
      const f = fixture();
      mocks.accept.mockRejectedValueOnce(
        new WorkflowCallAdmissionStoppedError(reason),
      );
      expect(await acceptWorkflowCallCandidate(f.transaction, input)).toEqual({
        kind: 'stopped',
        reason,
      });
      expect(f.order).toHaveLength(3);
    },
  );
  it.each(['PTA01', 'PTA02', 'PTA03', '40001', '40P01', '57014'])(
    'requires outer rollback for unexpected SQLSTATE %s',
    async (code) => {
      const f = fixture();
      const error = Object.assign(new Error('SQL failure'), { code });
      mocks.accept.mockRejectedValueOnce(error);
      await expect(
        acceptWorkflowCallCandidate(f.transaction, input),
      ).rejects.toBe(error);
      expect(f.order).toEqual(['savepoint workflow_call_candidate']);
    },
  );
  it.each([
    undefined,
    null,
    'primitive failure',
    {
      name: 'WorkflowCallAdmissionRefusedError',
      reasonCode: 'workflow.child_capacity_unavailable',
    },
  ])('does not classify primitive or lookalike errors %#', async (error) => {
    const f = fixture();
    mocks.accept.mockRejectedValueOnce(error);
    await expect(
      acceptWorkflowCallCandidate(f.transaction, input),
    ).rejects.toBe(error);
    expect(f.order).toHaveLength(1);
  });
  it('performs no work when savepoint creation fails', async () => {
    const f = fixture();
    const error = new Error('connection failed');
    f.execute.mockRejectedValueOnce(error);
    await expect(
      acceptWorkflowCallCandidate(f.transaction, input),
    ).rejects.toBe(error);
    expect(mocks.accept).not.toHaveBeenCalled();
  });
  it('does not classify release failure even if it resembles a typed refusal', async () => {
    const f = fixture();
    const error = new WorkflowCallAdmissionRefusedError(
      'workflow.child_capacity_unavailable',
    );
    f.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
    await expect(
      acceptWorkflowCallCandidate(f.transaction, input),
    ).rejects.toBe(error);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, new Error('cleanup failed')])(
    'retains original refusal and failed recovery %# for whole rollback',
    async (recoveryError) => {
      const f = fixture();
      const refusal = new WorkflowCallAdmissionRefusedError(
        'workflow.child_queue_unavailable',
      );
      mocks.accept.mockRejectedValueOnce(refusal);
      f.execute
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(recoveryError);
      await expect(
        acceptWorkflowCallCandidate(f.transaction, input),
      ).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [refusal, recoveryError],
      });
      expect(f.execute).toHaveBeenCalledTimes(2);
    },
  );
  it('preserves a failure releasing the recovered savepoint', async () => {
    const f = fixture();
    const stopped = new WorkflowCallAdmissionStoppedError('cancel_requested');
    const releaseError = new Error('release failed');
    mocks.accept.mockRejectedValueOnce(stopped);
    f.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(releaseError);
    await expect(
      acceptWorkflowCallCandidate(f.transaction, input),
    ).rejects.toMatchObject({ errors: [stopped, releaseError] });
    expect(f.execute).toHaveBeenCalledTimes(3);
  });
  it('rejects caller-supplied authority before savepoint creation', async () => {
    const f = fixture();
    const injected = { ...input, call: { ...input.call, actorId: runId } };
    await expect(
      acceptWorkflowCallCandidate(f.transaction, injected),
    ).rejects.toBeDefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
