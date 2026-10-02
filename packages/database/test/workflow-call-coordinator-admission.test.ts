import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  admitWorkflowCallDeclarations,
  prepareWorkflowCallAdmissionPass,
  sealWorkflowCallAdmissionPass,
} from '../src/execution/workflow-calls/workflow-call-coordinator-admission.js';
import {
  WorkflowCallAdmissionRefusedError,
  WorkflowCallAdmissionStoppedError,
} from '../src/execution/workflow-calls/workflow-call-admission.js';
import type { WorkspaceTransaction } from '../src/tenant-access/workspace.js';
import type { AcceptWorkflowCallRunInput } from '../src/execution/runs/workflow-call-acceptance.js';

const mocks = vi.hoisted(() => ({ accept: vi.fn() }));
vi.mock('../src/execution/runs/execution-acceptance.js', () => ({
  acceptWorkflowRun: mocks.accept,
}));
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parent = { parentRunId: id(1), expectedParentRevision: 7 };
const releases = [
  {
    epoch: 5,
    fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
    catalogJson: JSON.stringify({
      domain: 'pertexo.node-compatibility-release',
      schemaVersion: 1,
    }),
  },
];
const candidate = (key: string): AcceptWorkflowCallRunInput => ({
  operation: 'workflow.run.accept',
  triggerType: 'workflow_call',
  workflowId: id(2),
  workflowVersionId: id(3),
  engineVersion: 'engine-v3',
  initialCheckpoint: {},
  call: { ...parent, invocationKey: key },
});
const accepted = {
  runId: id(4),
  outboxEventId: id(5),
  acceptedAt: new Date('2026-10-02T10:00:00Z'),
  duplicate: false,
  status: 'queued' as const,
};
const input = {
  ...parent,
  compatibilityReleases: releases,
  candidates: [candidate('first'), candidate('second')],
};
function fixture(recordError?: Error) {
  const order: string[] = [];
  const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const execute = vi.fn((statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    statements.push(query);
    order.push(
      query.sql.includes('app.prelock_workflow_call_parent')
        ? 'prelock'
        : query.sql.includes('app.record_workflow_call_outcome')
          ? `record:${String(query.params[2])}`
          : query.sql.includes('app.seal_workflow_call_parent')
            ? 'seal'
            : query.sql,
    );
    if (
      recordError !== undefined &&
      query.sql.includes('app.record_workflow_call_outcome')
    )
      return Promise.reject(recordError);
    return Promise.resolve({ rows: [] });
  });
  const transaction = {
    workspaceId: id(6),
    db: { execute },
  } as unknown as WorkspaceTransaction;
  mocks.accept.mockImplementation(
    (_transaction, value: AcceptWorkflowCallRunInput) => {
      order.push(`accept:${value.call.invocationKey}`);
      return Promise.resolve(accepted);
    },
  );
  return { transaction, execute, order, statements };
}
beforeEach(() => vi.resetAllMocks());

describe('private coordinator Call admission pass', () => {
  it('allows existing own-run validation after prerequisites and before candidate savepoints', async () => {
    const f = fixture();
    const pass = await prepareWorkflowCallAdmissionPass(f.transaction, input);
    expect(f.order).toEqual(['prelock']);
    expect(mocks.accept).not.toHaveBeenCalled();
    f.order.push('own-run-lock-and-receipt');
    await pass.admit();
    expect(f.order.slice(0, 4)).toEqual([
      'prelock',
      'own-run-lock-and-receipt',
      'savepoint workflow_call_candidate',
      'accept:first',
    ]);
    const statements = f.statements.length;
    await expect(pass.admit()).rejects.toThrow('already consumed');
    expect(f.statements).toHaveLength(statements);
  });

  it('does not reuse a prepared pass after an operational failure', async () => {
    const f = fixture();
    const failure = Object.assign(new Error('lock failure'), { code: '40P01' });
    const pass = await prepareWorkflowCallAdmissionPass(f.transaction, input);
    mocks.accept.mockRejectedValue(failure);
    await expect(pass.admit()).rejects.toBe(failure);
    const statements = f.statements.length;
    await expect(pass.admit()).rejects.toThrow('already consumed');
    expect(f.statements).toHaveLength(statements);
    expect(mocks.accept).toHaveBeenCalledOnce();
    expect(f.order).not.toContain('seal');
  });
  it('prelocks once before candidates and records only after each same-client savepoint release', async () => {
    const f = fixture();
    const outcomes = await admitWorkflowCallDeclarations(f.transaction, input);
    expect(f.order).toEqual([
      'prelock',
      'savepoint workflow_call_candidate',
      'accept:first',
      'release savepoint workflow_call_candidate',
      'record:first',
      'savepoint workflow_call_candidate',
      'accept:second',
      'release savepoint workflow_call_candidate',
      'record:second',
    ]);
    expect(mocks.accept.mock.calls.every(([tx]) => tx === f.transaction)).toBe(
      true,
    );
    expect(outcomes).toEqual(
      input.candidates.map(({ call }) => ({
        invocationKey: call.invocationKey,
        outcome: { kind: 'accepted', accepted },
      })),
    );
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(outcomes.every(Object.isFrozen)).toBe(true);
    expect(f.statements[0]?.params).toEqual([
      parent.parentRunId,
      parent.expectedParentRevision,
      JSON.stringify(
        releases.map(({ epoch, fingerprint, catalogJson }) => ({
          epoch,
          fingerprint,
          catalog: JSON.parse(catalogJson) as unknown,
        })),
      ),
    ]);
    expect(f.statements[3]?.params).toEqual([
      parent.parentRunId,
      parent.expectedParentRevision,
      'first',
      JSON.stringify({
        kind: 'admitted',
        childRunId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      }),
    ]);
    expect(f.order).not.toContain('seal');
  });

  it.each([
    [
      'refused',
      new WorkflowCallAdmissionRefusedError(
        'workflow.child_capacity_unavailable',
      ),
      { kind: 'refused', reasonCode: 'workflow.child_capacity_unavailable' },
    ],
    [
      'canceled',
      new WorkflowCallAdmissionStoppedError('cancel_requested'),
      { kind: 'aborted', reason: 'cancel_requested' },
    ],
    [
      'expired',
      new WorkflowCallAdmissionStoppedError('deadline_expired'),
      { kind: 'aborted', reason: 'deadline_expired' },
    ],
  ] as const)(
    'journals a definite %s only after candidate rollback/release',
    async (_label, error, journal) => {
      const f = fixture();
      mocks.accept.mockRejectedValueOnce(error);
      await admitWorkflowCallDeclarations(f.transaction, input);
      expect(f.order.slice(0, 5)).toEqual([
        'prelock',
        'savepoint workflow_call_candidate',
        'rollback to savepoint workflow_call_candidate',
        'release savepoint workflow_call_candidate',
        'record:first',
      ]);
      expect(f.statements[4]?.params.at(-1)).toBe(JSON.stringify(journal));
      expect(mocks.accept).toHaveBeenCalledTimes(2);
    },
  );

  it('records canonical replay identity without starting a replacement protocol', async () => {
    const f = fixture();
    mocks.accept.mockResolvedValueOnce({
      ...accepted,
      duplicate: true,
      status: 'succeeded',
    });
    await admitWorkflowCallDeclarations(f.transaction, {
      ...input,
      candidates: [candidate('first')],
    });
    expect(f.statements.at(-1)?.params.at(-1)).toBe(
      JSON.stringify({
        kind: 'admitted',
        childRunId: accepted.runId,
        outboxEventId: accepted.outboxEventId,
      }),
    );
    expect(f.order).toEqual([
      'prelock',
      'savepoint workflow_call_candidate',
      'release savepoint workflow_call_candidate',
      'record:first',
    ]);
  });

  it.each([
    { ...input, parentRunId: 'bad' },
    { ...input, expectedParentRevision: -1 },
    { ...input, compatibilityReleases: [] },
    {
      ...input,
      candidates: Array.from({ length: 65 }, (_, i) => candidate(String(i))),
    },
    { ...input, candidates: [candidate('same'), candidate('same')] },
    {
      ...input,
      candidates: [
        {
          ...candidate('first'),
          call: { ...candidate('first').call, parentRunId: id(9) },
        },
      ],
    },
    {
      ...input,
      candidates: [
        {
          ...candidate('first'),
          call: { ...candidate('first').call, expectedParentRevision: 8 },
        },
      ],
    },
    { ...input, candidates: [{ ...candidate('first'), runInput: {} }] },
  ])(
    'validates the complete bounded context before any database work %#',
    async (invalid) => {
      const f = fixture();
      await expect(
        admitWorkflowCallDeclarations(f.transaction, invalid),
      ).rejects.toThrow();
      expect(f.execute).not.toHaveBeenCalled();
      expect(mocks.accept).not.toHaveBeenCalled();
    },
  );

  it('does not open a prerequisite pass for an empty candidate list', async () => {
    const f = fixture();
    const outcomes = await admitWorkflowCallDeclarations(f.transaction, {
      ...input,
      candidates: [],
    });
    expect(outcomes).toEqual([]);
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('accepts the exact 64-candidate bound sequentially with one prerequisite pass', async () => {
    const f = fixture();
    const candidates = Array.from({ length: 64 }, (_, i) =>
      candidate(String(i)),
    );
    const outcomes = await admitWorkflowCallDeclarations(f.transaction, {
      ...input,
      candidates,
    });
    expect(outcomes.map(({ invocationKey }) => invocationKey)).toEqual(
      candidates.map(({ call }) => call.invocationKey),
    );
    expect(f.order.filter((entry) => entry === 'prelock')).toHaveLength(1);
    expect(mocks.accept).toHaveBeenCalledTimes(64);
    for (let i = 0; i < 64; i += 1)
      expect(f.order.slice(1 + i * 4, 5 + i * 4)).toEqual([
        'savepoint workflow_call_candidate',
        `accept:${String(i)}`,
        'release savepoint workflow_call_candidate',
        `record:${String(i)}`,
      ]);
  });

  it('propagates failed prerequisite authority unchanged before any candidate', async () => {
    const f = fixture();
    const error = Object.assign(new Error('proof missing'), { code: 'PWC03' });
    f.execute.mockRejectedValueOnce(error);
    await expect(
      admitWorkflowCallDeclarations(f.transaction, input),
    ).rejects.toBe(error);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('stops after an unexpected candidate failure and requires whole-transaction recovery', async () => {
    const f = fixture();
    const error = Object.assign(new Error('serialization failure'), {
      code: '40001',
    });
    mocks.accept.mockRejectedValueOnce(error);
    await expect(
      admitWorkflowCallDeclarations(f.transaction, input),
    ).rejects.toBe(error);
    expect(f.order).toEqual(['prelock', 'savepoint workflow_call_candidate']);
    expect(mocks.accept).toHaveBeenCalledOnce();
  });

  it('does not return a partial pass after an earlier accepted identity and a later operational failure', async () => {
    const f = fixture();
    const error = Object.assign(new Error('later lock failure'), {
      code: '40P01',
    });
    mocks.accept.mockResolvedValueOnce(accepted).mockRejectedValueOnce(error);
    await expect(
      admitWorkflowCallDeclarations(f.transaction, {
        ...input,
        candidates: [...input.candidates, candidate('third')],
      }),
    ).rejects.toBe(error);
    expect(f.order).toEqual([
      'prelock',
      'savepoint workflow_call_candidate',
      'release savepoint workflow_call_candidate',
      'record:first',
      'savepoint workflow_call_candidate',
    ]);
    expect(mocks.accept).toHaveBeenCalledTimes(2);
    expect(f.order).not.toContain('seal');
  });

  it('never continues after a released candidate whose journal write failed', async () => {
    const error = Object.assign(new Error('journal conflict'), {
      code: 'PWC03',
    });
    const f = fixture(error);
    await expect(
      admitWorkflowCallDeclarations(f.transaction, input),
    ).rejects.toBe(error);
    expect(mocks.accept).toHaveBeenCalledOnce();
    expect(f.order).toEqual([
      'prelock',
      'savepoint workflow_call_candidate',
      'accept:first',
      'release savepoint workflow_call_candidate',
      'record:first',
    ]);
  });
});

describe('private post-CAS Call admission seal', () => {
  it.each([undefined, id(8)])(
    'binds only the exact parent/revision and continuation identity %#',
    async (continuation) => {
      const f = fixture();
      await sealWorkflowCallAdmissionPass(f.transaction, {
        ...parent,
        ...(continuation === undefined
          ? {}
          : { continuationOutboxEventId: continuation }),
      });
      expect(f.order).toEqual(['seal']);
      expect(f.statements[0]?.params).toEqual([
        parent.parentRunId,
        parent.expectedParentRevision,
        continuation ?? null,
      ]);
      expect(mocks.accept).not.toHaveBeenCalled();
    },
  );
  it('rejects an invalid continuation before SQL and preserves actual SQL proof failures', async () => {
    const f = fixture();
    await expect(
      sealWorkflowCallAdmissionPass(f.transaction, {
        ...parent,
        continuationOutboxEventId: 'bad',
      }),
    ).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    const error = Object.assign(new Error('CAS missing'), { code: 'PWC03' });
    f.execute.mockRejectedValueOnce(error);
    await expect(
      sealWorkflowCallAdmissionPass(f.transaction, parent),
    ).rejects.toBe(error);
  });
});
