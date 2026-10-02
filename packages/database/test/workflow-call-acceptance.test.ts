import { createHash } from 'node:crypto';
import { canonicalJson } from '@pertexo/workflow-model/canonical-json';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptWorkflowRun,
  IdempotencyRecordCorruptError,
} from '../src/execution/runs/execution-acceptance.js';
import {
  WorkflowCallAdmissionCorruptError,
  WorkflowCallAdmissionStoppedError,
} from '../src/execution/workflow-calls/workflow-call-admission.js';
import { serializeStoredExecutionValueV1 } from '../src/execution/stored-execution-value.js';
import { serializePersistedWorkflowCheckpointV3 } from '../src/compatibility/persisted-workflow-checkpoint-v3.js';
import {
  idempotencyRecords,
  workflowRuns,
  runEvents,
  runCheckpoints,
} from '../src/schema.js';
import type { WorkspaceTransaction } from '../src/tenant-access/workspace.js';

const mocks = vi.hoisted(() => ({
  ids: vi.fn<() => string>(),
  policy: vi.fn(),
  outbox: vi.fn(),
}));
vi.mock('../src/platform/persisted-id.js', () => ({
  generatePersistedId: mocks.ids,
}));
vi.mock(
  '../src/execution/notifications/failure-notification-policy.js',
  () => ({
    resolveWorkflowFailureNotificationPolicy: mocks.policy,
  }),
);
vi.mock('../src/execution/transport/outbox.js', async (original) => ({
  ...(await original<object>()),
  insertOutboxEvent: mocks.outbox,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const workflowId = '00000000-0000-4000-8000-000000000002';
const workflowVersionId = '00000000-0000-4000-8000-000000000003';
const ids = [
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
];
const parentRunId = '00000000-0000-4000-8000-000000000007';
const artifactId = '00000000-0000-4000-8000-000000000008';
const acceptedAt = new Date('2026-10-02T10:00:00.000Z');
const deadlineAt = '2026-10-02T10:30:00.000Z';
const pin = {
  workflowId,
  versionId: workflowVersionId,
  checksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  callableContractIdentity: `callable:v1:sha256:${'b'.repeat(64)}`,
};
function input() {
  return {
    operation: 'workflow.run.accept' as const,
    triggerType: 'workflow_call' as const,
    workflowId,
    workflowVersionId,
    engineVersion: 'test-engine',
    call: {
      parentRunId,
      expectedParentRevision: 5,
      invocationKey: `${workflowVersionId}|call|b:|i:`,
    },
    initialCheckpoint: {
      schemaVersion: 3,
      engineVersion: 'test-engine',
      workflowVersionId,
      revision: 0,
      runStatus: 'queued',
      nextEventSequence: 2,
      readySet: [],
      admittedInvocationKeys: [],
      invocations: [],
      joins: [],
      loops: [],
      branchSelections: [],
      calls: [],
      remainingIterationBudget: 1_000,
      cancelRequested: false,
      deadlineExpired: false,
    },
  };
}
function allowed() {
  return {
    kind: 'allowed',
    pin,
    engineVersion: 'test-engine',
    inputRef: {
      schemaVersion: 1,
      kind: 'inline',
      value: { message: 'declaration' },
    },
    inputChecksum: 'c'.repeat(64),
    inputRefJson:
      '{"kind":"inline","schemaVersion":1,"value":{"message":"declaration"}}',
    deadlineAt,
  };
}
function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function query(value: unknown) {
  return new PgDialect().sqlToQuery(value as SQL);
}

function fixture(
  options: {
    proof?: unknown;
    proofRows?: readonly unknown[];
    proofError?: unknown;
    reserved?: unknown;
    reserveRows?: readonly unknown[];
    reserveError?: unknown;
    runError?: unknown;
    claimed?: boolean;
    completed?: boolean;
    outboxError?: unknown;
  } = {},
) {
  const order: string[] = [];
  const values = new Map<unknown, Record<string, unknown>>();
  const queries: SQL[] = [];
  const select = vi.fn(() => {
    throw new Error('Call cannot use generic receipt replay');
  });
  const execute = vi.fn((statement: SQL) => {
    queries.push(statement);
    const first = queries.length === 1;
    order.push(first ? 'proof' : 'reserve');
    if (first && Object.hasOwn(options, 'proofError')) throw options.proofError;
    if (!first && Object.hasOwn(options, 'reserveError'))
      throw options.reserveError;
    return Promise.resolve({
      rows: first
        ? (options.proofRows ?? [
            {
              proof: Object.hasOwn(options, 'proof')
                ? options.proof
                : allowed(),
            },
          ])
        : (options.reserveRows ?? [
            {
              reserved: Object.hasOwn(options, 'reserved')
                ? options.reserved
                : true,
            },
          ]),
    });
  });
  const insert = vi.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      values.set(table, value);
      const name =
        table === idempotencyRecords
          ? 'claim'
          : table === workflowRuns
            ? 'run'
            : table === runEvents
              ? 'event'
              : table === runCheckpoints
                ? 'checkpoint'
                : 'unexpected';
      order.push(name);
      const result = {
        onConflictDoNothing: () => result,
        returning: () => {
          if (table === workflowRuns && Object.hasOwn(options, 'runError'))
            throw options.runError;
          return Promise.resolve(
            table === idempotencyRecords
              ? options.claimed === false
                ? []
                : [{ id: ids[0] }]
              : [{ acceptedAt }],
          );
        },
      };
      return result;
    },
  }));
  const update = vi.fn(() => ({
    set: (value: Record<string, unknown>) => {
      order.push('complete');
      values.set('completed', value);
      return {
        where: () => ({
          returning: () =>
            Promise.resolve(
              options.completed === false ? [] : [{ id: ids[0] }],
            ),
        }),
      };
    },
  }));
  mocks.policy.mockImplementation(() => {
    order.push('policy');
    return Promise.resolve(undefined);
  });
  mocks.outbox.mockImplementation(() => {
    order.push('outbox');
    if (Object.hasOwn(options, 'outboxError')) throw options.outboxError;
    return Promise.resolve(undefined);
  });
  let nextId = 0;
  mocks.ids.mockImplementation(() => {
    order.push('id');
    return ids[nextId++] ?? '';
  });
  return {
    transaction: {
      workspaceId,
      db: { execute, select, insert, update },
    } as unknown as WorkspaceTransaction,
    order,
    values,
    queries,
    execute,
    select,
    insert,
    update,
  };
}
beforeEach(() => vi.resetAllMocks());

describe('canonical workflow Call child acceptance', () => {
  it('uses SQL proof then canonical claim/run/event/CP3/outbox/reservation/completion in order', async () => {
    const f = fixture();
    const accepted = await acceptWorkflowRun(f.transaction, input());
    expect(f.order).toEqual([
      'id',
      'id',
      'id',
      'proof',
      'policy',
      'claim',
      'run',
      'event',
      'checkpoint',
      'outbox',
      'reserve',
      'complete',
    ]);
    expect(accepted).toEqual({
      acceptedAt,
      duplicate: false,
      runId: ids[1],
      outboxEventId: ids[2],
      status: 'queued',
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(query(f.queries[0]).sql).toContain(
      'app.lock_workflow_call_admission',
    );
    expect(query(f.queries[0]).params).toEqual([
      parentRunId,
      5,
      input().call.invocationKey,
      ids[1],
    ]);
    expect(query(f.queries[1]).sql).toContain(
      'app.reserve_workflow_call_active_admission',
    );
    expect(query(f.queries[1]).params).toEqual([
      parentRunId,
      5,
      input().call.invocationKey,
      ids[1],
      ids[2],
    ]);
    expect(f.select).not.toHaveBeenCalled();
    expect(f.insert).toHaveBeenCalledTimes(4);
    expect(f.values.get(workflowRuns)).toMatchObject({
      id: ids[1],
      workspaceId,
      workflowId,
      workflowVersionId,
      triggerType: 'workflow_call',
      status: 'queued',
    });
    expect(f.values.get(runEvents)).toEqual({
      workspaceId,
      workflowRunId: ids[1],
      sequence: 1,
      type: 'run.queued',
      payload: { schemaVersion: 1 },
    });
    expect(query(f.values.get(runCheckpoints)?.schedulerState).params).toEqual([
      serializePersistedWorkflowCheckpointV3(input().initialCheckpoint),
    ]);
    expect(mocks.outbox).toHaveBeenCalledWith(
      f.transaction,
      expect.objectContaining({
        id: ids[2],
        jobName: 'advance-workflow-run',
        aggregateId: ids[1],
        payload: {
          schemaVersion: 1,
          workspaceId,
          outboxEventId: ids[2],
          runId: ids[1],
        },
      }),
    );
  });
  it('derives private claim identity from exact pin/input SHA and initial CP3', async () => {
    const f = fixture();
    await acceptWorkflowRun(f.transaction, input());
    const initialCheckpointHash = sha256(
      serializePersistedWorkflowCheckpointV3(input().initialCheckpoint),
    );
    expect(f.values.get(idempotencyRecords)).toEqual({
      id: ids[0],
      workspaceId,
      operation: 'workflow.run.accept',
      scope: `workflow-call:${parentRunId}`,
      keyHash: sha256(input().call.invocationKey),
      requestHash: sha256(
        canonicalJson({
          pin,
          inputChecksum: allowed().inputChecksum,
          initialCheckpointHash,
        }),
      ),
      status: 'in_progress',
      resourceId: ids[1],
      resultRef: {},
    });
    expect(f.values.get('completed')).toMatchObject({
      status: 'completed',
      resultRef: { outboxEventId: ids[2], initialCheckpointHash },
    });
  });
  it('uses declaration artifact unchanged without any additional artifact/quota insertion', async () => {
    const inputRef = { schemaVersion: 1, kind: 'artifact', artifactId };
    const f = fixture({
      proof: {
        ...allowed(),
        inputRef,
        inputRefJson: serializeStoredExecutionValueV1(inputRef),
      },
    });
    await acceptWorkflowRun(f.transaction, input());
    expect(query(f.values.get(workflowRuns)?.inputRef).params).toEqual([
      serializeStoredExecutionValueV1(inputRef),
    ]);
    expect(f.insert.mock.calls.map(([table]) => table)).toEqual([
      idempotencyRecords,
      workflowRuns,
      runEvents,
      runCheckpoints,
    ]);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it('accepts exactly256KiB inline declaration value independently of StoredV1 wrapper overhead', async () => {
    const inputRef = {
      schemaVersion: 1,
      kind: 'inline',
      value: 'x'.repeat(262_142),
    };
    const f = fixture({
      proof: {
        ...allowed(),
        inputRef,
        inputRefJson: serializeStoredExecutionValueV1(inputRef),
      },
    });
    await acceptWorkflowRun(f.transaction, input());
    const serialized = serializeStoredExecutionValueV1(inputRef);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(262_144);
    expect(query(f.values.get(workflowRuns)?.inputRef).params).toEqual([
      serialized,
    ]);
  });
  it('rejects declaration inline value above256KiB before notification and candidate writes', async () => {
    const f = fixture({
      proof: {
        ...allowed(),
        inputRef: {
          schemaVersion: 1,
          kind: 'inline',
          value: 'x'.repeat(262_143),
        },
      },
    });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
    expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
  });
  it('bounds deadline to proof and child version through the existing SQL LEAST owner', async () => {
    const f = fixture();
    await acceptWorkflowRun(f.transaction, input());
    const deadline = query(f.values.get(workflowRuns)?.deadlineAt);
    expect(deadline.sql).toContain('least(');
    expect(deadline.sql).toContain("'{graph,settings,maxRunDurationMs}'");
    expect(deadline.params).toEqual([
      deadlineAt,
      workspaceId,
      workflowId,
      workflowVersionId,
    ]);
  });
  it('keeps recorded child identity without current policy, generic receipts or writes', async () => {
    const proof = {
      kind: 'recorded',
      pin,
      engineVersion: 'test-engine',
      accepted: {
        acceptedAt: acceptedAt.toISOString(),
        runId: artifactId,
        outboxEventId: parentRunId,
        status: 'succeeded',
      },
    };
    const f = fixture({ proof });
    expect(await acceptWorkflowRun(f.transaction, input())).toEqual({
      ...proof.accepted,
      acceptedAt,
      duplicate: true,
    });
    expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.select).not.toHaveBeenCalled();
    expect(mocks.policy).not.toHaveBeenCalled();
    expect(mocks.outbox).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it.each([
    'workflow.child_capacity_unavailable',
    'workflow.child_queue_unavailable',
    'workflow.child_entitlement_unavailable',
    'workflow.child_authority_unavailable',
    'workflow.child_admission_unavailable',
    'workflow.child_compatibility_unavailable',
  ])(
    'keeps explicit refusal %s before candidate writes',
    async (reasonCode) => {
      const f = fixture({
        proof: {
          kind: 'refused',
          pin,
          engineVersion: 'test-engine',
          reasonCode,
        },
      });
      await expect(
        acceptWorkflowRun(f.transaction, input()),
      ).rejects.toMatchObject({
        name: 'WorkflowCallAdmissionRefusedError',
        reasonCode,
      });
      expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
      expect(f.insert).not.toHaveBeenCalled();
    },
  );
  it.each(['cancel_requested', 'deadline_expired'])(
    'keeps ancestor stop %s before writes',
    async (reason) => {
      const f = fixture({
        proof: { kind: 'stopped', pin, engineVersion: 'test-engine', reason },
      });
      await expect(
        acceptWorkflowRun(f.transaction, input()),
      ).rejects.toBeInstanceOf(WorkflowCallAdmissionStoppedError);
      expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
      expect(f.insert).not.toHaveBeenCalled();
    },
  );
  it.each([
    'runInput',
    'deadlineAt',
    'rootRunId',
    'actorId',
    'candidateRunId',
    'scope',
    'keyHash',
    'requestHash',
    'replayCommandId',
    'replaySourceRunId',
    'workspaceId',
  ])(
    'rejects caller-owned root authority field %s before proof',
    async (field) => {
      const f = fixture();
      await expect(
        acceptWorkflowRun(f.transaction, { ...input(), [field]: parentRunId }),
      ).rejects.toBeDefined();
      expect(f.order).toEqual([]);
    },
  );
  it.each([
    'runInput',
    'deadlineAt',
    'rootRunId',
    'actorId',
    'candidateRunId',
    'scope',
    'keyHash',
    'requestHash',
    'replayCommandId',
    'workspaceId',
    'pin',
    'inputChecksum',
  ])('rejects injected child context %s', async (field) => {
    const f = fixture();
    await expect(
      acceptWorkflowRun(f.transaction, {
        ...input(),
        call: { ...input().call, [field]: parentRunId },
      }),
    ).rejects.toBeDefined();
    expect(f.order).toEqual([]);
  });
  it.each([
    { expectedParentRevision: -1 },
    { expectedParentRevision: 2_147_483_647 },
    { expectedParentRevision: 1.5 },
    { invocationKey: '' },
    { invocationKey: 'é'.repeat(129) },
    { parentRunId: 'not-an-id' },
  ])('rejects invalid exact child context %#', async (patch) => {
    const f = fixture();
    await expect(
      acceptWorkflowRun(f.transaction, {
        ...input(),
        call: { ...input().call, ...patch },
      }),
    ).rejects.toBeDefined();
    expect(f.order).toEqual([]);
  });
  it.each(['parentRunId', 'expectedParentRevision', 'invocationKey'])(
    'requires exact child context field %s',
    async (field) => {
      const f = fixture();
      const call: Record<string, unknown> = { ...input().call };
      Reflect.deleteProperty(call, field);
      await expect(
        acceptWorkflowRun(f.transaction, { ...input(), call } as ReturnType<
          typeof input
        >),
      ).rejects.toBeDefined();
      expect(f.order).toEqual([]);
    },
  );
  it('rejects noninitial CP3 before canonical ID allocation or SQL', async () => {
    const f = fixture();
    await expect(
      acceptWorkflowRun(f.transaction, {
        ...input(),
        initialCheckpoint: {
          ...input().initialCheckpoint,
          revision: 1,
        },
      }),
    ).rejects.toBeDefined();
    expect(f.order).toEqual([]);
  });
  it.each([1, 2, 4])(
    'rejects retained/noninitial format%s before allocations or SQL',
    async (schemaVersion) => {
      const f = fixture();
      await expect(
        acceptWorkflowRun(f.transaction, {
          ...input(),
          initialCheckpoint: {
            ...input().initialCheckpoint,
            schemaVersion,
          },
        }),
      ).rejects.toBeDefined();
      expect(f.order).toEqual([]);
    },
  );
  it('treats generic claim conflict as corruption without replacing durable identity', async () => {
    const f = fixture({ claimed: false });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    expect(f.order).toEqual(['id', 'id', 'id', 'proof', 'policy', 'claim']);
    expect(f.select).not.toHaveBeenCalled();
    expect(f.values.has(workflowRuns)).toBe(false);
    expect(f.execute).toHaveBeenCalledOnce();
  });
  it('returns typed capacity refusal after outbox but before claim completion without fresh retry', async () => {
    const f = fixture({ reserved: false });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toMatchObject({
      name: 'WorkflowCallAdmissionRefusedError',
      reasonCode: 'workflow.child_capacity_unavailable',
    });
    expect(f.order.slice(-2)).toEqual(['outbox', 'reserve']);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(mocks.ids).toHaveBeenCalledTimes(3);
    expect(f.update).not.toHaveBeenCalled();
  });
  it.each(['proofError', 'runError', 'reserveError', 'outboxError'] as const)(
    'propagates raw SQLSTATE/error at %s to the outer rollback owner',
    async (stage) => {
      const error = Object.assign(new Error('raw SQL'), { code: 'PTA02' });
      const f = fixture({ [stage]: error });
      await expect(acceptWorkflowRun(f.transaction, input())).rejects.toBe(
        error,
      );
      expect(f.update).not.toHaveBeenCalled();
      expect(f.select).not.toHaveBeenCalled();
    },
  );
  it.each(['PTA01', 'PTA03', '23505', '40001'])(
    'does not infer business refusal from SQLSTATE %s',
    async (code) => {
      const error = Object.assign(new Error('SQL'), { code });
      const f = fixture({ runError: error });
      await expect(acceptWorkflowRun(f.transaction, input())).rejects.toBe(
        error,
      );
    },
  );
  it.each([
    { engineVersion: 'other' },
    { pin: { ...pin, workflowId: parentRunId } },
    { pin: { ...pin, versionId: parentRunId } },
    { pin: { ...pin, extra: true } },
    { inputChecksum: 'bad' },
    { deadlineAt: 'bad' },
    { extra: true },
    {
      inputRef: {
        schemaVersion: 1,
        kind: 'workflow_call',
        invocationKey: 'call',
        childRunId: ids[1],
      },
    },
  ])('rejects mismatched or corrupt SQL proof %#', async (patch) => {
    const f = fixture({ proof: { ...allowed(), ...patch } });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
    expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
  });
  it.each([
    { proofRows: [] },
    { proofRows: [{ proof: allowed() }, { proof: allowed() }] },
    { proofRows: [{ proof: null }] },
  ])('requires exactly one definite proof row %#', async ({ proofRows }) => {
    const f = fixture({ proofRows });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
    expect(f.insert).not.toHaveBeenCalled();
  });
  it.each([
    { reserveRows: [] },
    { reserveRows: [{ reserved: true }, { reserved: true }] },
    { reserveRows: [{ reserved: null }] },
    { reserveRows: [{ reserved: 1 }] },
  ])(
    'requires exactly one definite reservation result %#',
    async ({ reserveRows }) => {
      const f = fixture({ reserveRows });
      await expect(
        acceptWorkflowRun(f.transaction, input()),
      ).rejects.toBeInstanceOf(WorkflowCallAdmissionCorruptError);
      expect(f.order.at(-1)).toBe('reserve');
      expect(f.update).not.toHaveBeenCalled();
    },
  );
  it('requires exactly one claim completion after successful reservation', async () => {
    const f = fixture({ completed: false });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    expect(f.order.slice(-3)).toEqual(['outbox', 'reserve', 'complete']);
  });
  it('retains notification pin and trace on the canonical child outbox', async () => {
    const f = fixture();
    const policy = {
      policyVersion: 1,
      destinationId: artifactId,
      destinationConfigVersion: 2,
      sideEffectClass: 'unsafe',
      connectionSecretVersionId: parentRunId,
    };
    mocks.policy.mockResolvedValueOnce(policy);
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    await acceptWorkflowRun(f.transaction, { ...input(), traceparent });
    expect(f.values.get(workflowRuns)).toMatchObject({
      failureNotificationPolicyVersion: 1,
      failureNotificationDestinationId: artifactId,
      failureNotificationDestinationConfigVersion: 2,
      failureNotificationSideEffectClass: 'unsafe',
      failureNotificationConnectionSecretVersionId: parentRunId,
    });
    expect(mocks.outbox.mock.calls[0]?.[1]).toMatchObject({
      payload: { traceparent },
    });
  });
  it('never manufactures a business refusal for an unexpected primitive error', async () => {
    const f = fixture({ proofError: undefined });
    await expect(
      acceptWorkflowRun(f.transaction, input()),
    ).rejects.toBeUndefined();
    expect(f.order).toEqual(['id', 'id', 'id', 'proof']);
  });
});
