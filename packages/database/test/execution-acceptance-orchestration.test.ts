import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptWorkflowRun,
  readWorkflowRunAcceptanceReplay,
  IdempotencyRecordCorruptError,
  WorkspaceRunQuotaExceededError,
} from '../src/execution/runs/execution-acceptance.js';
import { prepareWorkflowRunAcceptanceInput } from '../src/execution/runs/execution-acceptance-input.js';
import { serializeStoredExecutionValueV1 } from '../src/execution/stored-execution-value.js';
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
  () => ({ resolveWorkflowFailureNotificationPolicy: mocks.policy }),
);
vi.mock('../src/execution/transport/outbox.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  insertOutboxEvent: mocks.outbox,
}));

const workspaceId = '00000000-0000-4000-8000-000000000001';
const workflowId = '00000000-0000-4000-8000-000000000002';
const workflowVersionId = '00000000-0000-4000-8000-000000000003';
const candidateIds = [
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
];
const acceptedAt = new Date('2026-10-02T10:00:00.000Z');
function input() {
  return {
    engineVersion: 'test-engine',
    initialCheckpoint: {
      schemaVersion: 1,
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
      remainingIterationBudget: 0,
      cancelRequested: false,
      deadlineExpired: false,
    },
    keyHash: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    operation: 'workflow.run.accept' as const,
    scope: 'workflow:api',
    triggerType: 'api' as const,
    workflowId,
    workflowVersionId,
  };
}
function receipt() {
  return {
    requestHash: input().requestHash,
    resourceId: candidateIds[1],
    resultRef: {
      outboxEventId: candidateIds[2],
      initialCheckpointHash:
        prepareWorkflowRunAcceptanceInput(input()).initialCheckpointHash,
    },
    idempotencyStatus: 'completed',
    acceptedAt,
    runStatus: 'queued',
  };
}
function transaction(
  options: {
    reads?: readonly unknown[][];
    claimed?: boolean;
    completed?: boolean;
    runError?: Error;
  } = {},
) {
  const order: string[] = [];
  const values = new Map<unknown, Record<string, unknown>>();
  const reads = [...(options.reads ?? [[]])];
  const select = vi.fn(() => {
    order.push('read');
    const query = {
      from: () => query,
      leftJoin: () => query,
      where: () => query,
      limit: () => Promise.resolve(reads.shift() ?? []),
    };
    return query;
  });
  const execute = vi.fn(() => {
    order.push(execute.mock.calls.length === 1 ? 'regional' : 'workspace');
    return Promise.resolve({ rows: [{ status: 'active' }] });
  });
  const insert = vi.fn((table: unknown) => ({
    values: (value: Record<string, unknown>) => {
      values.set(table, value);
      order.push(
        table === idempotencyRecords
          ? 'claim'
          : table === workflowRuns
            ? 'run'
            : table === runEvents
              ? 'event'
              : 'checkpoint',
      );
      const query = {
        onConflictDoNothing: () => query,
        returning: () => {
          if (table === workflowRuns && options.runError !== undefined)
            return Promise.reject(options.runError);
          return Promise.resolve(
            table === idempotencyRecords
              ? options.claimed === false
                ? []
                : [{ id: candidateIds[0] }]
              : [{ acceptedAt }],
          );
        },
      };
      return query;
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
              options.completed === false ? [] : [{ id: candidateIds[0] }],
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
    return Promise.resolve(undefined);
  });
  let nextId = 0;
  mocks.ids.mockImplementation(() => {
    order.push('id');
    return candidateIds[nextId++] ?? '';
  });
  return {
    transaction: {
      workspaceId,
      db: { select, execute, insert, update },
    } as unknown as WorkspaceTransaction,
    order,
    values,
  };
}
beforeEach(() => vi.resetAllMocks());

describe('workflow acceptance orchestration retained contract', () => {
  it('keeps replay first and avoids admission, notification locks, IDs and writes', async () => {
    const fixture = transaction({ reads: [[receipt()]] });
    expect(await acceptWorkflowRun(fixture.transaction, input())).toMatchObject(
      {
        duplicate: true,
        runId: candidateIds[1],
        outboxEventId: candidateIds[2],
      },
    );
    expect(fixture.order).toEqual(['read']);
    expect(mocks.ids).not.toHaveBeenCalled();
    expect(mocks.policy).not.toHaveBeenCalled();
  });

  it('keeps the receipt-only reader independent of checkpoint and run input', async () => {
    const fixture = transaction({ reads: [[receipt()]] });
    const { keyHash, requestHash, operation, scope } = input();
    expect(
      await readWorkflowRunAcceptanceReplay(fixture.transaction, {
        keyHash,
        requestHash,
        operation,
        scope,
      }),
    ).toMatchObject({ duplicate: true });
    expect(fixture.order).toEqual(['read']);
  });

  it('preserves lock, candidate allocation and canonical write ordering', async () => {
    const fixture = transaction();
    const accepted = await acceptWorkflowRun(fixture.transaction, {
      ...input(),
      runInput: { name: 'input' },
      deadlineAt: acceptedAt,
    });
    expect(fixture.order).toEqual([
      'read',
      'regional',
      'workspace',
      'policy',
      'id',
      'id',
      'id',
      'claim',
      'run',
      'event',
      'checkpoint',
      'outbox',
      'complete',
    ]);
    expect(accepted).toEqual({
      acceptedAt,
      duplicate: false,
      runId: candidateIds[1],
      outboxEventId: candidateIds[2],
      status: 'queued',
    });
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(fixture.values.get(idempotencyRecords)).toMatchObject({
      id: candidateIds[0],
      resourceId: candidateIds[1],
      status: 'in_progress',
      resultRef: {},
    });
    expect(fixture.values.get(workflowRuns)).toMatchObject({
      id: candidateIds[1],
      workflowId,
      workflowVersionId,
      triggerType: 'api',
      status: 'queued',
    });
    expect(fixture.values.get(runEvents)).toEqual({
      workspaceId,
      workflowRunId: candidateIds[1],
      sequence: 1,
      type: 'run.queued',
      payload: { schemaVersion: 1 },
    });
    expect(fixture.values.get(runCheckpoints)).toMatchObject({
      workspaceId,
      workflowRunId: candidateIds[1],
      workflowVersionId,
      revision: 0,
      engineVersion: 'test-engine',
    });
    expect(fixture.values.get('completed')).toMatchObject({
      status: 'completed',
      resultRef: {
        outboxEventId: candidateIds[2],
        initialCheckpointHash:
          prepareWorkflowRunAcceptanceInput(input()).initialCheckpointHash,
      },
    });
    const deadline = new PgDialect().sqlToQuery(
      fixture.values.get(workflowRuns)?.deadlineAt as SQL,
    );
    expect(deadline.sql).toContain('least(');
    expect(deadline.sql).toContain("'{graph,settings,maxRunDurationMs}'");
    expect(deadline.params).toEqual([
      acceptedAt.toISOString(),
      workspaceId,
      workflowId,
      workflowVersionId,
    ]);
    const runInput = new PgDialect().sqlToQuery(
      fixture.values.get(workflowRuns)?.inputRef as SQL,
    );
    expect(runInput.params).toEqual([
      serializeStoredExecutionValueV1({
        schemaVersion: 1,
        kind: 'inline',
        value: { name: 'input' },
      }),
    ]);
    expect(mocks.outbox).toHaveBeenCalledWith(
      fixture.transaction,
      expect.objectContaining({
        id: candidateIds[2],
        aggregateId: candidateIds[1],
        jobName: 'advance-workflow-run',
        payload: {
          schemaVersion: 1,
          workspaceId,
          outboxEventId: candidateIds[2],
          runId: candidateIds[1],
        },
      }),
    );
  });

  it('resolves a lost claim race without creating a candidate run', async () => {
    const fixture = transaction({ reads: [[], [receipt()]], claimed: false });
    expect(await acceptWorkflowRun(fixture.transaction, input())).toMatchObject(
      { duplicate: true },
    );
    expect(fixture.order).toEqual([
      'read',
      'regional',
      'workspace',
      'policy',
      'id',
      'id',
      'id',
      'claim',
      'read',
    ]);
    expect(fixture.values.has(workflowRuns)).toBe(false);
  });

  it('retains the acceptance-time notification pin and trace context', async () => {
    const fixture = transaction();
    const policy = {
      policyVersion: 1,
      destinationId: workflowId,
      destinationConfigVersion: 2,
      sideEffectClass: 'unsafe',
      connectionSecretVersionId: workflowVersionId,
    };
    mocks.policy.mockResolvedValueOnce(policy);
    const traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    await acceptWorkflowRun(fixture.transaction, { ...input(), traceparent });
    expect(fixture.values.get(workflowRuns)).toMatchObject({
      failureNotificationPolicyVersion: policy.policyVersion,
      failureNotificationDestinationId: policy.destinationId,
      failureNotificationDestinationConfigVersion:
        policy.destinationConfigVersion,
      failureNotificationSideEffectClass: policy.sideEffectClass,
      failureNotificationConnectionSecretVersionId:
        policy.connectionSecretVersionId,
      inputRef: null,
      inputRefExpiresAt: null,
    });
    expect(mocks.outbox.mock.calls[0]?.[1]).toMatchObject({
      payload: { traceparent },
    });
  });

  it('fails closed if the lost claim has no complete receipt', async () => {
    const fixture = transaction({ claimed: false });
    await expect(
      acceptWorkflowRun(fixture.transaction, input()),
    ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    expect(fixture.values.has(workflowRuns)).toBe(false);
  });

  it('requires exactly one completed claim after writing the outbox', async () => {
    const fixture = transaction({ completed: false });
    await expect(
      acceptWorkflowRun(fixture.transaction, input()),
    ).rejects.toBeInstanceOf(IdempotencyRecordCorruptError);
    expect(fixture.order.slice(-2)).toEqual(['outbox', 'complete']);
  });

  it('retains operation-local SQLSTATE mapping at the moved run insertion', async () => {
    const fixture = transaction({
      runError: Object.assign(new Error('database'), { code: 'PTA02' }),
    });
    await expect(
      acceptWorkflowRun(fixture.transaction, input()),
    ).rejects.toBeInstanceOf(WorkspaceRunQuotaExceededError);
    expect(fixture.order.at(-1)).toBe('run');
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it.each([
    { triggerType: 'workflow_call' },
    { extra: true },
    { runInput: { text: 'x'.repeat(262_144) } },
  ])(
    'retains strict trigger/field and inline limits before reads %#',
    async (patch) => {
      const fixture = transaction();
      await expect(
        acceptWorkflowRun(fixture.transaction, {
          ...input(),
          ...patch,
        } as ReturnType<typeof input>),
      ).rejects.toBeDefined();
      expect(fixture.order).toEqual([]);
    },
  );
});
